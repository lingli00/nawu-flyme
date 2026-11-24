---
name: nawu-bookkeeping
description: 用「纳物 NaWu」通用数据 API 做**双向**数据助手（v2.1，对齐服务端 1.7.8）。正向：口语/订单截图/商品图 → 解析 → 确认 → commit/mutate 写入；反向：查账、查物品、查订阅、**聚合统计**、**单实体全景**、按条件筛选（含「有没有图」）、值不值/日均成本。**订阅图标可自动检索**（`/api/ai/icons` 按名称查品牌图标）。支持 12 集合任意字段读写、自定义分类/归需/字段/功能、图片云端托管（上传→引用，不再塞 base64）。写入先落「云端待入账」，用户需在 App/网页「AI 接入」页确认合并。唯一不做的事：账号级设置（账号/登录/服务器等）请用户自己在界面操作。
---

# 纳物 NaWu · 数据助手（记账 + 查账，v2.1 / 对齐 1.7.8）

用户说「午饭 35」「昨天买了耳机 899」「腾讯视频月卡 25」，或发来订单/账单截图、商品图 →
你转成规范结构 → 映射分类 → 调 API 入账。
用户问「这个月花了多少」「耳机值不值」「订阅每月多少钱」「上次那双鞋多少钱」→ 你**读 API 直接回答**。

> **服务端 1.7.8 起的四条铁律先记住**
> 1. **字段字典以 `/api/ai/schema` 为准**，本文下面所有表格只是速查；自相矛盾时信 schema。
> 2. **服务端会自动补默认字段与归一化图片**（`EntityNormalize`）——你不必写全所有字段，但你给得越准，用户看到的越准。
> 3. **图片走云端托管**（`/api/user/images`），记录里只存 `{source:'cloud', ref, sha256}` 引用；不要再把大段 base64 塞进记录。
> 4. **算数用 `/api/ai/stats`，查单件用 `/api/ai/entity`，配订阅图标用 `/api/ai/icons`** —— 这三个是 1.8.1 新增的专用接口，别再用笨办法。

## 配置

- 配置（含密钥，勿外传）：`/path/to/config.sh`
  - `BOOKKEEPING_BASE_URL`（如 https://your-host）、`BOOKKEEPING_API_KEY`（`nawu_sk_xxx`）
- 用法：`source /path/to/config.sh`
- 认证：`Authorization: Bearer $BOOKKEEPING_API_KEY`，`Content-Type: application/json`
- ⚠️ **Key 同时能通吃两套接口**：`/api/ai/*`（Bearer 直接支持）与 `/api/user/images/*`（同样 Bearer）。
- ⚠️ Key 是敏感凭据，只放 config.sh，**绝不写进记忆、聊天或日志**；`/api/ai/keys` 的 `key` 字段只出现一次。

## 端点一览

### A. 数据面 `/api/ai/*`（读写全部 12 集合）

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/ai/schema` | GET | **先读**：12 集合完整字段字典 + 归需选项/分类/自定义字段/自定义功能 |
| `/api/ai/context` | GET | 上下文：物品、订阅、最近 20 条流水、本月收支、每月订阅成本、today |
| `/api/ai/collections?name=<集合>` | GET | 读任意集合（`limit`≤1000 默认 200、`offset`、`filter`=JSON） |
| `/api/ai/query` | POST | 多条件查询（`filter` 支持 `$gte/$lte/$gt/$lt/$ne/$contains/$in/$nin/$or/$and/$not/$exists/$regex/$size/$hasImage`，+ `sortBy/desc/fields/limit/offset`） |
| **`/api/ai/stats`** | POST | **★聚合统计**：计数/求和/均值/极值/分组/去重。**要算总额、分类占比、按月趋势，用它，不要拉全量自己算** |
| **`/api/ai/entity`** | GET | **★单实体全景**：`?collection=goods&id=<id>` → 实体本身 + 派生摘要 + 关联记录（物品→使用记录/流水/提醒；订阅→账单） |
| **`/api/ai/icons`** | GET | **★图标检索**：`?q=Netflix,B站大会员,阿里云&limit=5` → 匹配的 `brand:<slug>` / 随包图标路径 / emoji。**订阅配图标先查这个，别猜 slug** |
| `/api/ai/mutate` | POST | **通用写入**：`upsert/update/delete/replace` 任意集合任意字段 |
| `/api/ai/parse` | POST | 只解析（只读），返回草稿，**不入账** |
| `/api/ai/commit` | POST | 解析+落库（`text`/`items`/`draft`/`operations` 四选一） |
| `/api/ai/ask` | POST | 服务端规则问答（查账 / 值不值 / 订阅汇总），口径与客户端一致 |
| `/api/ai/categories` | GET/POST/DELETE | 读/增/删 生活流、物品、订阅分类 |
| `/api/ai/options` | GET/POST | 自定义归需选项、判定规则、自定义字段、任意设置 |
| `/api/ai/actions` | GET/POST/DELETE | 注册/删除任意新功能（动作模板） |
| `/api/ai/actions/run` | POST | 调用自定义功能 |
| `/api/ai/inbox` | GET/DELETE | 待入账明细 / 按事件 id 撤销（撤销同步清云快照） |
| `/api/ai/inbox/apply` | POST | 标记事件已被客户端合并（一般由客户端调，你不调） |
| `/api/ai/keys` | GET/POST/DELETE | Key 管理（**别乱用，泄露风险**） |
| `/api/ai/openapi.json` | GET | OpenAPI 3.1 全量规范（免鉴权） |

### B. 图片面 `/api/user/images*`（v1.8.0 新增，Bearer）

| 端点 | 方法 | 入参 | 返回 / 作用 |
|---|---|---|---|
| `/api/user/images` | POST | JSON `{"image":"<dataURL 或裸 base64>"}`（也可二进制直传） | `{ok,sha256,size,mime,ext,url,deduped}`；**同图秒去重**（`deduped:true`） |
| `/api/user/images/list` | GET | — | `{ok,hashes:[...],count}`（差异比对：本地有、云端没有的才上传） |
| `/api/user/images/sign?sha=a,b,c` | GET | `sha` 逗号分隔、可选 `ttl` | `{ok,urls:{sha:url}}` 重签读取 URL |
| `/api/user/images/gc` | POST | `{"referenced":[sha,…]}` | `{ok,deleted,kept,skipped}` 回收未被引用图（**必须传数组**，空数组也要传） |
| `/api/user/images/<sha>?t=&s=` | GET | 签名参数 | 图片二进制，**`<img>` 直接可访问**；HMAC 签名 **24h** 有效 |

> **注意鉴权差异**：`/api/ai/*` 的 GET 用 Bearer（API Key 即可）；
> `/api/user/images/sign`、`/list`、`/gc`、`POST` 都要 Bearer；**唯独 `GET /api/user/images/<sha>` 靠 URL 签名**（浏览器 `<img>` 带不了 Authorization），
> 所以把 URL 发给用户/写进记录时**必须带 `t=`/`s=`**，或存相对路径 `/api/user/images/<sha>` 由客户端重新签名。

## 12 个集合（均可读写 + 附加自定义字段）

| 集合 | 说明 | 关键字段（速查，详见 `/api/ai/schema`） |
|---|---|---|
| `goods` | 物品库（耐用品） | name*, price*, buyDate, categoryId(cgX), tags[], extraFees[{name,amount}], feeRatePermille, incomes[], sellPrice, targetDailyCost, countEnabled/totalCount/usedCount, warrantyDate, warrantyRemind{on,leadDays,time}, status(active/retired/favorite), currency, image |
| `subscriptions` | 订阅（周期性扣款） | name*, amount*, period(month/year/week), every, type(recurring/lifetime), startDate, nextRenewDate, endDate, autoRenew, initSpent, categoryId(csX), icon, remind{renewLead}, image |
| `bills` | 订阅账单 | subId*, dueDate*, amount, status(paid/pending/skipped/failed), paidDate, refund |
| `valueRecords` | 生活流（每笔收支） | type(expense/income)*, amount*, date*, categoryId(clX), judgement(归需), note, image, src, refId |
| `categories` | 分类表 | id, name*, kind*(ledger/goods/sub), icon, order |
| `wishlist` | 心愿单 | name*, price, url, image(字符串形态), reasons[], channel, note, deadline |
| `cooldowns` | 冷静期 | name*, until, untilAt, hours, amount, reason, url, image(字符串形态) |
| `moods` | 情绪速写 | feeling, text, crushed, inHeart, date |
| `times` | 时间切片 | durationMin, tags[], meaning, date, note |
| `usageRecords` | 使用打卡 | goodsId*, date |
| `reminders` | 提醒 | kind(goods_warranty/sub_renew), refId, at, done |
| `walls` | 心墙 | text*, color |

**必读**：
- 带 `*` 的是 schema 里的 required；但**从 v1.7.7 起服务端会补齐缺失字段**（见下节），所以「漏填」不会写坏数据，只是可能不是用户想要的值。
- 任意集合允许附加自定义字段（如 goods 的 `purchaseChannel`），**原样保留**。想让字段出现在字典里，用 `POST /api/ai/options` 的 `customFields` 声明。
- 集合名/enum 值**一律照抄**：`clX`=生活流、`cgX`=物品、`csX`=订阅，**三者绝不能混用**（把 cg0 写进 valueRecords.categoryId 是最常见的错）。

## 服务端会自动补什么（v1.7.7 · 不必你再手工填全，但知道它能少踩坑）

所有写入口（`commit` 的 items/operations、`mutate` 的 upsert/patch/replace）都会过 `normalizeRow → EntityNormalize::fillDefaults`，**只补缺失、绝不覆盖你给的值**：

| 集合 | 自动补齐的字段（缺失时） |
|---|---|
| `goods` | `tags:[] extraFees:[] incomes:[] status:'active' currency:'CNY' categoryId:'cg0' name:'未命名物品' price:0 createdAt/updatedAt` |
| `subscriptions` | `categoryId:'cs0' icon:'credit-card' currency:'CNY' type:'recurring' period:'month' every:1 autoRenew:true status:'active' remind:{renewLead:3} name:'未命名订阅' amount:0`；且**给了 startDate 但没给 nextRenewDate 时，按 period/every 自动推算** |
| `valueRecords` | `type:'expense' currency:'CNY' categoryId:'cl0' judgement:'xu' amount:0`（**不补 createdAt**，沿用历史行为） |
| `bills` | `currency:'CNY' status:'pending' subId:'' amount:0` |
| `wishlist` / `cooldowns` / `moods` / `times` / `usageRecords` / `reminders` / `walls` / `categories` | 各自必填数组/枚举/字符串兜底（`categories` 默认 kind:'ledger' icon:'tag' order:99） |

另有 AI 层补的：`id`（按前缀生成，如 `g_…`）、`createdAt`/`updatedAt`、数值字段强转数字、`valueRecords.judgement` 归一（中文→`gui/xu/fou`）。
`items` 用老 `kind` 写法时还自动补：`goods` 的 `amount→price`、`date→buyDate`（`goods` 还会自动生成一笔 `"买入：<名称>"` 的生活流支出）；`subscriptions`/`goods` 缺 name 时用 note 顶上。

> **所以**：`{"items":[{"kind":"ledger","amount":35,"note":"午饭"}]}` 也能落库（date=今天、cl0、xu）；
> 但用户说「昨天 · 打车 · 25 · 交通」时，**把 date/categoryId/type/judgement 都写准**，比依赖兜底有用得多。
> 反过来：**不要为了省事把 categoryId 留空**——留空一律落 `cl0 餐饮`，账就错了。

## 关键：文本格式决定解析精度

**用「品名 + 空格 + 数字」格式**，规则解析器极准：
- ✅ `"午饭 35"` → 餐饮 cl0
- ✅ `"奶茶 7.9元"` → 餐饮 cl0
- ✅ `"打车 25元"` → 交通 cl1
- ❌ `"喝了杯奶茶，花了7块9"`（中文金额"块9"）→ 品名解析不出，默认归日用 cl11

**口语 → 规范格式转换**：
1. 提取每笔品名 + 金额（"7块9"→7.9；"两千五"→2500；服务端认中文数字/口语小数/常见日期）。
2. 金额统一数字（支持小数）；日期可用 昨天/前天/3月5日。
3. 多笔用逗号分隔：`"奶茶 7.9元，吃饭 29.9元"`。
4. 用户没给金额先问，**不要编造**。

> ⚠️ 规则引擎的日期只认得：今天/刚才、昨天/昨晚、前天、大前天、明天、上周（=昨天-7天）、上个月、`3月5日`/`3-5`、`本月 X 日`。
> **「上周五」「周一开始的」这类它一律回落成今天** → 这时你自己算好 `YYYY-MM-DD` 用结构化 `items` 传 `date`，别用 text。
> `ask` 的时间范围也用它自己的一套（今天/昨天/本周/上周/上个月/今年/近N天/近N个月，默认本月），只覆盖 `valueRecords`。

## 分类表（默认值；用户可能改过，以 `/api/ai/categories` 或 schema 的 `categories` 为准）

### 生活流 kind=ledger（24 个）
| id | 名称 | 典型关键词 |
|---|---|---|
| cl0 | 餐饮 | 早饭/午饭/晚饭/外卖/奶茶/咖啡/火锅/下馆子/吃/喝/零食/夜宵/甜品 |
| cl1 | 交通 | 打车/滴滴/公交/地铁/高铁/机票/加油/停车/过路费 |
| cl2 | 居住 | 房租/房贷/水电/燃气/物业/暖气 |
| cl3 | 学习 | 书/课程/网课/培训/学费/考试 |
| cl4 | 健康 | 药/看病/医院/体检/挂号 |
| cl5 | 娱乐 | 电影/演唱会/KTV/门票/剧本杀 |
| cl6 | 人情 | 红包/份子钱/请客/随礼/送人 |
| cl7 | 其他 | 杂项（**排序垫底**，id 也特殊，请不要按序号猜） |
| cl8 | 服饰 | 衣服/裤子/外套/鞋 |
| cl9 | 饰品 | 项链/戒指/耳环/手链 |
| cl10 | 食材 | 买菜/水果/肉/蔬菜/鸡蛋/米面/油盐/生鲜 |
| cl11 | 日用 | 纸巾/洗发水/牙膏/洗衣液/生活用品/桶装水 |
| cl12 | 美妆 | 口红/粉底/面膜/护肤品 |
| cl13 | 数码 | 耳机/手机/电脑/平板/充电器/软件 |
| cl14 | 通讯 | 话费/流量/宽带/套餐 |
| cl15 | 游戏 | 游戏充值/点券/皮肤 |
| cl16 | 云服务 | 云盘/云存储/服务器 |
| cl17 | 宠物 | 猫粮/狗粮/猫砂/宠物看病 |
| cl18 | 旅行 | 酒店/民宿/景点门票/旅游 |
| cl19 | 健身 | 健身卡/私教/瑜伽/游泳 |
| cl20 | 母婴 | 奶粉/尿不湿/婴儿用品 |
| cl21 | 办公 | 文具/打印/笔/本子 |
| cl22 | 保险 | 保费 |
| cl23 | 维修 | 维修/修理/换屏/补胎/配件 |

### 物品 kind=goods（13 个）
`cg0` 数码 / `cg1` 衣物 / `cg2` 家居 / `cg3` 美妆 / `cg4` 厨房 / `cg5` 运动 / `cg6` 交通 / `cg7` 家电 / `cg8` 工具 / `cg9` 玩具 / `cg10` 乐器 / `cg11` 珠宝 / `cg12` 日用

### 订阅 kind=sub（6 个）
`cs0` 影音 / `cs1` 效率 / `cs2` 学习 / `cs3` 云服务 / `cs4` 游戏 / `cs5` 生活

> **归类判断**：实体耐用品（耳机/手机）→ `goods`；消耗品/服务/一次性小额 → `valueRecords`；周期性扣款 → `subscriptions`。
> 解析器能自动判 kind，但**批量/带图/金额大时请自己指定 `kind`/`collection`**，别赌规则。
> 分类不够用 → `POST /api/ai/categories` 自己加（`icon` 用 lucide 名如 `coffee`）。

## 是否归需（judgement）选项

内置：`gui`(归·值得) / `xu`(需·必要) / `fou`(否·本可避免)。
中文「归」「需」「否」、别名（值得/必要/刚需/不值/浪费等）、自定义选项及 label 前缀都会自动归一。
- 详情：`GET /api/ai/options` 的 `judgementOptions`、`judgementRules`（关键词→归需，例如「冲动」→fou）。
- 自定义：`POST /api/ai/options` 加 `{"value":"tun","label":"囤 · 囤货","aliases":["囤","囤货"],"color":"#b98a1f"}`。
- ⚠️ 写 `mutate update` 的 patch 时，`judgement` 也会被归一，不必自己转码。

## 写入方式（四选一，按场景挑）

**A. 自然语言**（交给服务端规则引擎，最省事，适合 1~3 笔简单口语、且日期在它认识的范围内）：
```bash
curl -s --max-time 30 -X POST "$BOOKKEEPING_BASE_URL/api/ai/commit" \
  -H "Authorization: Bearer $BOOKKEEPING_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"午饭 35"}'
```

**B. 结构化 items**（更准，**默认选择**；`collection` 可指定任意集合、字段全透传）：
```json
{"items":[
  {"kind":"ledger","type":"expense","amount":35,"categoryId":"cl0","judgement":"xu","date":"2026-11-10","note":"午饭"},
  {"kind":"goods","name":"索尼 WH-1000XM5","amount":1899,"categoryId":"cg0","buyDate":"2026-11-10","ledgerCategoryId":"cl13"}
]}
```
> `goods` 走老 `kind` 写法时，用 `ledgerCategoryId` 指定「同时记的那笔生活流支出」的分类；不指定会落 cl0。

**C. draft 回传**：`parse` 回来改完再 `{"draft":{...}}` 传回去，适合「先预览再确认」。

**D. operations 批量**（最灵活，一次落多集合多笔；适合截图批量入账、物品+关联记录、**以及所有 update/delete**）：
```json
{"operations":[
  {"op":"upsert","collection":"goods","record":{"name":"显示器","price":1299,"buyDate":"2026-11-10","categoryId":"cg0","image":{"source":"cloud","ref":"/api/user/images/<sha>?t=&s=","sha256":"<sha>"}}},
  {"op":"upsert","collection":"valueRecords","record":{"type":"expense","amount":1299,"date":"2026-11-10","categoryId":"cl13","note":"买入：显示器"}}
]}
```
`op` 取值：`upsert|insert|create`（新增/按 id 覆盖）、`update|patch`（**必须带已存在记录的 `id` + `patch`**）、`delete|remove`（`id` 或 `ids`）、`replace|set`（整集合替换，**危险，慎用**）。

## 图片云端托管（v1.8.0 · 必读）

### 流程（固定三步）
1. **先看云端有什么**（可选但推荐，省流量）：`GET /api/user/images/list` → `hashes`。
2. **上传**：`POST /api/user/images` body `{"image":"<dataURL>"}`（或裸 base64/二进制），拿到 `{sha256, url, deduped}`。
3. **写进记录**：`image` 传 `{"source":"cloud","ref":"/api/user/images/<sha>","sha256":"<sha>"}`，或直接传 `"cloud:<sha>"` / 裸 64 位 sha / `/api/user/images/<sha>` 字符串，服务端都会归一成 cloud 形态。

```bash
# 上传（把 dataURL 放进 image 字段；单张 ≤2MB）
curl -s --max-time 30 -X POST "$BOOKKEEPING_BASE_URL/api/user/images" \
  -H "Authorization: Bearer $BOOKKEEPING_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":"data:image/jpeg;base64,/9j/4AAQ..."}'
# → {"ok":true,"sha256":"<64hex>","size":123456,"mime":"image/jpeg","ext":"jpg","url":"/api/user/images/<sha>?t=..&s=..","deduped":false}

# 重签（URL 过期/换端后）
curl -s "$BOOKKEEPING_BASE_URL/api/user/images/sign?sha=<sha1>,<sha2>" -H "Authorization: Bearer $BOOKKEEPING_API_KEY"
# → {"ok":true,"urls":{"<sha1>":"/api/user/images/<sha1>?t=..&s=.."}}
```

### image 字段能接受的写法（服务端 `EntityNormalize::image` 全认）

| 你传 | 服务端实际存 | 备注 |
|---|---|---|
| `{"source":"cloud","ref":"/api/user/images/<sha>","sha256":"<sha>"}` | `{source:'cloud', ref:'/api/user/images/<sha>', sha256}` | **推荐** |
| `"cloud:<sha>"` / 裸 `<sha>` / `/api/user/images/<sha>` | 同上（规范成相对路径） | 换域名不失效 |
| `"https://…"` / `{"source":"url","ref":"https://…"}` | `{source:'web', ref:<url>}` | **第三方图**，会失效；重要图请先下载再上传到云端 |
| `"data:image/png;base64,…"` / `{"source":"base64","ref":"<裸base64>"}` / `"img:dataURL"` | `{source:'local', ref:'data:image/<真实类型>;base64,…'}` | 裸 base64 会自动按**魔数**补正确 MIME（不是一律 jpeg） |
| `{"source":"system","ref":"🎧"}` / 单个 emoji / 短中文（≤8 字） | `{source:'system', ref}` | 系统图标 |
| `{"source":"brand","ref":"brand:<slug>"}` / `"brand:<slug>"` | `{source:'brand', ref:'brand:<slug>'}` | 内置品牌 glyph，见下节 |
| `{"source":"builtin","ref":"headphones"}` / 裸 lucide id | `{source:'builtin', ref:'headphones'}` | 图标库 id |
| `null` / `{}` / `""` / 不传 | **写入时不写 image**；读取时补 `{source:'system', ref:'📦'}` | 写入不硬塞 📦 是刻意的 |

> 完整 source 枚举：**`system | local | web | builtin | brand | cloud`**
> （`cloud` 是 v1.8.0 云端托管新增；`EntityNormalize::IMAGE_SOURCES` 里的老枚举常量只列到 builtin，别被它误导。
>  旧文档里的 `url/upload/base64` 已废弃，传了也会按内容重判，但别再用。）

### 图片硬限制与坑
- **单张上限 = 解码后 2MB**（base64 字符串 ≈3,200,000 字符）。超限**不截断、直接拒绝该图并返回 `warning`**，其它字段照常写入。
- 只收位图：jpeg/png/gif/webp/bmp/ico。**SVG 一律拒**（可能内嵌脚本，XSS）。
- **正常受支持**：`image` 也接受 **数组**（如 `["base64","<裸base64>"]`，会自动取第一个有效元素）、被**双重 JSON 编码**的字符串。
- `wishlist` / `cooldowns` 的 `image` 是**字符串形态**：`img:<dataURL>` / `url:<https>` / `brand:<slug>` / 裸 lucide id。传对象也行，服务端会自动转成字符串。
- **仍然建议压缩**（不再是硬要求）：长边 ~900px、JPEG quality 80 递给服务端，2MB 以内就够；省流量、省上传时间、也省你自己的 token。
- 上传频控：300 张/小时。
- 同一张图重复上传 → `deduped:true`，**秒返回**，不重复占盘（内容寻址 sha256 去重）。

### ⭐ 三条图片匹配规则（用户明确要求，必须遵守）

**1. 物品（goods）—— 必须用实物图**
- 物品的 `image` = **实物照片**（用户拍的产品/到手图）。
- **绝不拿订单截图、支付截图、店铺商品图当物品图**。
- **手上没有实物图 → 直接问用户要**（"这件有实物照片吗？发我一张我给它配上"），**不要猜、不要编、不要用 emoji 顶替**。
- 只有用户明确说"没图/不用图"时，才留空（服务端不写 image，客户端回落分类图标）。

**2. 订阅（subscriptions）—— 自己去找对应 logo**

> **★ v1.8.1 起有专门的检索接口，先查它，别再靠猜 slug 或翻附录。**

```bash
curl -s --max-time 30 "$BOOKKEEPING_BASE_URL/api/ai/icons?q=Netflix,B站大会员,阿里云&limit=5" \
  -H "Authorization: Bearer $BOOKKEEPING_API_KEY"
```

返回每条 `matched.write` **直接就是该写进 `subscriptions.icon` 的值**，三种形态之一：

| `write` 形态 | 含义 | 例 |
|---|---|---|
| `brand:<slug>` | 内置矢量字形（前端即时绘制，备份只占几字节） | `brand:netflix`、`brand:bilibili` |
| `/brand-icons/<域名>.png` | 随包品牌图标（离线可用） | `/brand-icons/v.qq.com.png` |
| `url:/api/icon/img?d=<域名>` | 站内图标代理（回源取目标站真实图标） | `url:/api/icon/img?d=foo.com` |

- 查不到时响应的 `suggestion` 会给出兜底方案（域名提示 + `credit-card` 图标 + emoji），照着走。
- 实测命中率（180 个品牌）：`Netflix→brand:netflix(96分)`、`B站大会员→brand:bilibili(70分)`、`阿里云→brand:alibabacloud(92)`、`腾讯视频→/brand-icons/v.qq.com.png`、`spotify→brand:spotify(96)`。
- **降级顺序**：`/api/ai/icons` 查到的 `write` → `/api/icon/img?d=<域名>` → 下载 logo 后 `POST /api/user/images` 上传写 cloud 引用 → lucide id（`tv`/`play`/`music`/`game`/`cloud`/`server`/`ai`/`card`）。
- **都走不通**才反馈「需要补图标」，不要塞不相干的图标糊过去。

**3. 生活流（valueRecords）—— 不需要配图**
- 识别订单/账单截图或口述内容，**直接按金额/日期/分类/品名入账即可**，`image` 留空。
- 只有用户明确说"这笔要存小票/存图"时，才把那张图上传并写进 `image`。

### 批量订单截图入账的顺序
1. 逐张 OCR/肉眼读出：品名、实付金额、成交日期（**实付价已含优惠，别用原价**）。
2. 列成表给用户确认（品名 / 金额 / 日期 / 分类 / 是否耐用品）。
3. 耐用品 → 每件单独回溯要实物图；没有就明确列出来问用户。
4. 一次性 `commit`（items 或 operations）批量落库；**一张截图对应一件物品时，把该物品图一一对应**，别串图。
5. 多模态不可用时用 `tesseract` OCR 兜底读金额/日期。

## 反向读取（数据助手模式 · 与写入同等重要）

> 用户的要求：**除了「账号设置」（账号/登录/服务器/密码这类）不用 skill 做，其余全部用 API 完成，并且要能反向读取。**
> 也就是：查账、查物品、查订阅、统计、筛选、对比、追溯——**一律调 API 拿真数据再回答，绝不凭记忆/推测编数字**。

### 读取速查表

| 用户问什么 | 怎么取数 | 关键点 |
|---|---|---|
| 这个月花了多少 / 收入多少 | `GET /api/ai/context` 的 `monthly`，或 `POST /api/ai/ask {"question":"本月花了多少"}` | context 的 monthly = 本月(`Y-m-01`~`Y-m-t`) 收支合计；默认本月 |
| 今天/昨天/本周/上月/近 N 天花了多少 | `POST /api/ai/query` `collection=valueRecords` + `filter.date.$gte/$lte` | **自己算日期边界**，比 ask 更可控 |
| 某分类花了多少 | `POST /api/ai/stats` `filter:{"categoryId":"cl13","type":"expense"}` `sum:["amount"]` | **无需自己 sum** |
| 各分类占比 / 近 N 月趋势 | `POST /api/ai/stats` `groupBy:"categoryId"` 或 `groupBy:"month"` | 一次拿全，别再拉全量自己算 |
| 归需结构（归/需/否占比） | `POST /api/ai/ask {"question":"本月归需否占比"}` | 注意 ask 的 judgementBreakdown **只认中文键**「归/需/否」，服务端已替你映射 |
| 「买了什么」「最近买啥」 | `POST /api/ai/ask {"question":"最近买了什么"}` 或 `query` valueRecords 按 date desc | ask 只返回最近 10 条、只覆盖 valueRecords |
| 我有哪些物品 / 某件物品详情 | `GET /api/ai/collections?name=goods` | 可用 `filter`（如 `{"categoryId":"cg0"}`） |
| 某件物品多少钱、什么时候买的 | `query` `collection=goods` `filter.name.$contains=<关键词>` `fields` 裁剪 | `$contains` 是**字符串包含**，中文可用 |
| 物品值不值 / 日均成本 / 回本 | `POST /api/ai/ask {"question":"耳机值不值"}` | 服务端口径：总投入=price+extraFees，日均=总投入/持有天数，卖出按 `src='goods-sale'` 或 `refId` 汇总 |
| 还没退役/心爱的物品 | `query` goods `filter:{"status":"retired"}` 或 `"favorite"` | status 只有 active/retired/favorite |
| 保修快到期的 | `query` goods `filter:{"warrantyDate":{"$lte":"<30天后>"}}` | `warrantyRemind` 只是提醒配置 |
| 在用的订阅 / 每月订阅成本 | `GET /api/ai/context` 的 `monthlySubscriptionCost`，或 `query` subscriptions | 计算口径：month→amount/every，year→amount/(12*every)，week→amount*52/(12*every) |
| 某订阅什么时候到期/下次扣款 | `query` subscriptions `filter:{"name":{"$contains":"腾讯"}}` 看 `nextRenewDate/endDate/autoRenew` | AI 写入时若只给 startDate，服务端会推算 nextRenewDate |
| 账单/扣款记录 | `query` bills `filter:{"subId":"s_x"}` 或 `{"status":"pending"}` | 四态 paid/pending/skipped/failed |
| 某件物品用了几次 | `GET /api/ai/entity?collection=goods&id=g_x` 的 `derived` + `related.usageRecords` | 一次拿全；也可 `query usageRecords filter.goodsId` |
| **哪些物品还没有图（需要向用户要）** | `POST /api/ai/stats` 或 `query` + `filter:{"$hasImage":false}` | **用户要求：物品必须有实物图，没图就要向用户索取** |
| 分类清单 | `GET /api/ai/categories?kind=ledger|goods|sub` | 用户可能改过/加过，**别用本文的默认表当真相** |
| 心愿单 / 冷静期 / 情绪 / 时间 / 心墙 | `GET /api/ai/collections?name=wishlist|cooldowns|moods|times|walls` | 冷门集合同样可读可写 |
| 待入账有几条、卡了什么 | `GET /api/ai/inbox` | 每条有 `summary`（集合/标题/金额/日期/字段名）+ `itemCount` |
| 某个自定义功能 | `GET /api/ai/actions`，`POST /api/ai/actions/run` | 参数模板 `{{参数名}}` |

### 查询语法要点（`/api/ai/query` 与 `/api/ai/collections` 的 `filter`）
```json
{
  "collection": "valueRecords",
  "filter": {"date": {"$gte": "2026-11-01", "$lte": "2026-11-30"}, "type": "expense", "$or": [{"categoryId":"cl0"},{"categoryId":"cl1"}]},
  "sortBy": "date", "desc": true, "fields": ["date","amount","note","categoryId"], "limit": 200, "offset": 0
}
```
- 支持：精确等值、`$gte/$lte/$gt/$lt/$ne/$contains/$in/$nin/$or/$and/$not/$exists/$regex/$size`，以及 **`$hasImage`（true=有自己传的图，false=没有；服务端补的 📦 占位不算）**。
- **聚合统计用 `/api/ai/stats`，别再拉全量自己 reduce**（见下节）。

### 聚合统计 `POST /api/ai/stats`（v1.8.1 · 算钱必备）

```bash
curl -s --max-time 30 -X POST "$BOOKKEEPING_BASE_URL/api/ai/stats" \
  -H "Authorization: Bearer $BOOKKEEPING_API_KEY" -H "Content-Type: application/json" \
  -d '{"collection":"valueRecords","filter":{"type":"expense"},
       "sum":["amount"],"groupBy":"month","dateField":"date","from":"2026-01-01"}'
# → {"ok":true,"collection":"valueRecords","total":90,
#    "metrics":{"amount":{"count":90,"sum":2258.89,"avg":25.1,"min":0,"max":1320}},
#    "groups":[{"key":"2026-10","count":39,"amount":1785.44},{"key":"2026-11","count":49,"amount":373.45}]}
```

| 参数 | 说明 |
|---|---|
| `collection` | 必填，任意集合 |
| `filter` | 同 `query` 的语法（含 `$hasImage`） |
| `sum` / `avg` / `min` / `max` | 对哪些数值字段算（传字段名数组） |
| `groupBy` | 字段名，或特殊值 `month` / `year` / `$hasImage` |
| `dateField` + `from` / `to` | 按日期字段圈定区间 |

> 典型问题直接用：本月总额、各分类占比、近 6 个月趋势、某物品累计投入、有图/无图物品各几件。

### 单实体全景 `GET /api/ai/entity`（v1.8.1）

```bash
curl -s --max-time 30 "$BOOKKEEPING_BASE_URL/api/ai/entity?collection=goods&id=g_xxx" \
  -H "Authorization: Bearer $BOOKKEEPING_API_KEY"
# → {"ok":true,"row":{...},"derived":{使用次数/已投入/关联消费/有图/保修日},"related":{usageRecords,valueRecords,reminders,...}}
```
问「这件东西我都花过什么钱」「这个订阅扣过几次」——**一次调用拿全，不用拼多个 query**。
- 排序：`sortBy` 单字段，数值比大小、字符串按字典序；`desc:true` 反序。
- 上限：`limit` 最大 1000（`collections` 默认 200，`query` 默认 100）；`collections` 的 `filter` 走 GET 的 **JSON 字符串**参数。
- `POST /api/ai/query` 的 `collection` 也可写成 `name`。
- 读回的数据**已被服务端归一化**（缺字段补全、图片统一成 `{source,ref}`）——**看到什么就转述什么**，不要自己臆造 `undefined`。

### 回答口径（与客户端保持一致，别自创）
- **「这个月」= 自然月 `Y-m-01`~`Y-m-t`**；不要用「近 30 天」冒充。
- **收入/支出**只按 `valueRecords.type` 分；物品的买入支出**已经单独落在 valueRecords 里**（`note:"买入：XX"`），**不要**再把 goods.price 加一遍（否则重复计账）。
- **日均成本** = (price + extraFees − sellPrice) / 持有天数，已退役物品的持有天数**定格在退役日**（`updatedAt` 日期）。
- **转卖净赚** = sellPrice − (price + extraFees)；客户端只在**净赚为正**时自动生成一条 `src:'goods-sale'` 的收入记录。
- 先给结论数字，再给 1~3 行依据（时间段、条数、Top 分类）；用户要明细再展开。

## 工作流（必守）

1. 用户口语/截图描述消费 → 你解析出「品名 + 金额 + 日期 + 分类」。
2. 不确定的：`parse` 试一下，或用 `query` 查同类历史记录（保持分类一致）。
3. 简单口语 → 组结构化 `items`（**默认**）；批量/带图/多集合 → `operations`。想预演就加 `"dryRun": true`。
4. 需要图 → 按上面的三条匹配规则办（物品要实物图、订阅找 logo、生活流不配图）。
5. `commit`/`mutate` 落库（写操作，首次需用户在确认卡片批准）。
6. 汇报结果 + **提醒用户：去 App/网页「AI 接入 → 第 3 步」点「合并」才进本机**。
7. **立刻可查**：写入后 `ask`/`query` 已能算到（服务端 `withPending()` 会并入待入账），可以顺手让用户确认"现在这个月是多少"。
8. **⚠️ 物品入账后必须做一次「缺图巡检」**（血的教训）：
   ```bash
   # 找出所有没有实物图的物品（服务端补的 📦 占位不算图）
   curl -s --max-time 30 -X POST "$BOOKKEEPING_BASE_URL/api/ai/query" \
     -H "Authorization: Bearer $BOOKKEEPING_API_KEY" -H "Content-Type: application/json" \
     -d '{"collection":"goods","filter":{"$hasImage":false},"fields":["id","name","buyDate"],"limit":50}'
   ```
   把结果列给用户，**逐件索要实物图**。没图的物品会显示成分类图标兜底，观感很差。

> **为什么这条是硬要求**：2026-11-22 曾因批量导入的物品缺少 `extraFees` 等字段 + 图片格式不对，
> 导致 App/网页**整页崩溃**（`Cannot read properties of undefined`）。服务端现在会自动补默认字段、
> 自动归一化图片格式，但**"有没有图"这件事只有你能把关**。

## 场景细则（实战沉淀，重要）

### 1. 日期一律以「业务发生日」为准，别按命令执行日
- 口述当天买的 → 用**系统当天**（用户口述没截图的清单，默认当天，别凭上下文脑补成别的日期）。
- 历史订单截图（咸鱼/淘宝成交单）→ 用**成交时间**（或用户指定的业务日），即使今天才发图、命令今天才跑通，date 也按业务日记。被质疑时**先查聊天/截图时间戳**再改，别来回横跳。
- 命令哪天跑通与 date 无关。
- 拿不准就先看 `GET /api/ai/context` 的 `today`（服务端时区 Asia/Shanghai，与网页一致）。

### 2. 卖二手耐用品 = 先建/改 goods 物品，不是直接记 income
- 用户「卖了把键盘，买时 50 卖 89，手续费 2.6%，运费 3.6」→ 走**物品流程**：
  `goods` 设 `price=买入价`、`sellPrice=卖价`、`extraFees=[{name:"运费",amount:3.6}]`（**运费属于总投入**）、
  `feeRatePermille=26`（千分比：2.6% → 26，**不是 2.6**）、`status:'retired'`（退役才计入回本/净赚）。
- 净赚 = sellPrice − (price + extraFees)；**客户端会在净赚为正时自动生成** `src:'goods-sale'` 的生活流收入，所以**你别再手记一笔 income**，否则重复计收入。
- `incomes[]` 是历史数组结构，客户端目前**不参与**净赚计算（只认 sellPrice/extraFees）——想保留流水可以写进去，但**别指望它算账**。
- **别图省事直接记一笔 income**，会丢物品投入/日均成本/回本追踪。

### 3. 待入账能不能改？（v1.7.7 实测口径）
- **不需要"等合并"就能改**：`commit`/`mutate` 一落库，服务端立刻把记录合进**最新快照**（`mergedToSnapshot:true`），
  `GET /api/ai/inbox`、`collections`、`query` 能立刻读到 → **有 `id` 可寻址**。
- 所以「改了字段 / 换了图 / 补了 sellPrice」→ 用 `mutate` 的 `{"op":"update","collection":…,"id":"…","patch":{…}}` 直接改，**不必撤销重建**。
- 两种例外，仍然只能撤销重建：
  1. 服务端**没有快照**（从没客户端备份过）→ 记录只在待入账里，`mergedToSnapshot:false`，此时 `update` 找不到 id；
  2. 你改错了**事件本身**（比如一整批 10 条都记错）→ 直接 `DELETE /api/ai/inbox {"ids":[1,2]}` 撤销更干净，撤销会把这些记录从云快照剔除、不留残账。
- 撤销 `DELETE /api/ai/inbox` 支持 `{"id":N}` 或 `{"ids":[…]}`；撤销后这些记录在 App 里也不会出现。
- 结论：**首次尽量组完整**（含 image/sellPrice/extraFees），已经写错了就 `update` 修（有 id）或 `delete` 重来（没 id / 整批错）。

### 4. 订阅 initSpent 补录历史 + nextRenewDate 陷阱
- 用户说「这个是补充的/补录历史已花」→ 用订阅的 `initSpent` 记历史已花，**不是新建周期扣款**。
- 一次性长周期项目（域名注册到 2030）→ 用 `type:'lifetime'`，或记订阅时**显式给 `nextRenewDate`（真实到期日）**；只给 `startDate` 时服务端会按 period 推算，可能离谱，**人工核对改到真实到期日，或关掉 `autoRenew`**。
- 「每个月多少钱」= `amount + period:'month' + every:1`；季付 = `period:'month', every:3`；年付 = `period:'year'`。按"每月成本"比较时先折月。
- `endDate`（到期不续）与 `nextRenewDate`（下次扣款）是**两个不同字段**，别混。

### 5. 图片（见上文「图片云端托管」三条规则）
- **压缩不再是硬要求**（上限 2MB），但**建议仍压缩**（长边 ~900px / JPEG 80），省流量。
- 上传失败/`/api/user/images` 不可用（老服务器）→ 退回 `image` 传 dataURL 字符串也能存（≤2MB），只是会占快照体积。
- 批量截图入账时，**物品图一一对应**；订单详情截图本身不是物品图。
- 多模态识别不可用（`model_not_found`）时，用 `tesseract` OCR 兜底读金额/日期。

### 6. 网络 / curl 挂起
- `curl` POST 大 payload 易挂起 → **一律加 `--max-time 30`**（图片上传尤其），或用 `-o /tmp/resp.json` 存盘再读，或改用 Python `urllib`。
- ⚠️ **`/api/user/images` 只读 JSON body**：二进制直传分支要求 `Content-Type: image/*`，但服务端该分支实际从 `php://input` 读字节、`flyme_param()` 解析不到参数，**当前不可用** → **图片上传统一走 JSON `{"image":…}`**。
- 带 base64 的 payload 可能几百 KB~2MB（合规范围），正常，别慌；`-d @file.json` 比命令行内联安全。

### 7. 批量入账的确认表（用户最在意的三件事）
入账前把表列给用户：**品名 / 金额（实付） / 日期（业务日） / 分类 / 图片有无或链接**。
- 金额用**优惠后实付**，别用原价/标价；多件合并订单要拆到件。
- 金额小数不要四舍五入掉分。
- 用户改口（"那个是 39 不是 35"）→ 有 id 就 `update`，没 id 就 `DELETE inbox` 后重建。

## 账号级设置：不用 skill 做
账号注册/登录、改密码、站点地址、消息通知、备份策略、AI 接入页开关……**这些属于账号/客户端设置，请用户自己在网页或 App 里操作**。
其余功能（数据、分类、归需、字段、自定义功能、图片）**都能用 API 完成**。

## 常见错误与规避（踩过的坑，逐条对照）

| # | 现象 / 报错 | 根因 | 正确做法 |
|---|---|---|---|
| 1 | `{"ok":false,"error":"未知集合：xxx"}` | 集合名拼错或用了中文 | 用 schema 的 `collectionNames`：goods/subscriptions/bills/valueRecords/moods/times/wishlist/cooldowns/categories/usageRecords/reminders/walls |
| 2 | 物品详情页崩 / 字段 `undefined` | 老版本 AI 写入漏了 `tags/extraFees/incomes` | 1.7.7 已由服务端补齐；**若你仍看到缺字段，重写一遍记录或报 bug**，不要自己 `as` 强转 |
| 3 | 图不显示、显示成 📦 | 传了裸 base64 无 `data:` 前缀（旧版）／传了 `{source:'url'}` 但 ref 是垃圾 | 传 dataURL 或 `cloud:` 引用；**不确定就先上传拿 cloud URL** |
| 4 | 图片被拒绝，响应里有 `warnings` | 超过 2MB / 不是位图 / 是 SVG | 压缩到 2MB 内再传；SVG 先转 PNG。**warning 是"这张图没存"，其它字段已写入** |
| 5 | 访问 `/api/ai/xxx` 报 **404 `未知的 AI 接口`** | 端点名拼错或用了旧/不存在的能力 | 端点以 `GET /api/ai/openapi.json` 为准（本文表格已对齐 1.7.7） |
| 6 | 401 `需要登录，或用 Authorization: Bearer <API Key> 鉴权` | 没带/带错 Key；Key 被撤销 | 检查 `source config.sh` 是否生效、`Authorization: Bearer $BOOKKEEPING_API_KEY` |
| 7 | 401 / 403 访问 `/api/user/images/<sha>` | 签名 `t=`/`s=` 缺失或过期（24h） | 调 `/api/user/images/sign` 重签，或记录里存相对路径让客户端签 |
| 8 | `429 图片上传太频繁` | 300 张/小时频控 | 先 `list` 比对，只传缺的；`deduped:true` 说明同图已存在 |
| 9 | `409/400 需要 operations 数组` | `mutate` body 结构错 | 必须是 `{"operations":[…],"dryRun":false}`，`ops` 也认但别用 |
| 10 | `update` 后记录没变 | `op:"update"` 缺 `id` 或 `patch` | 先 `query`/`inbox` 拿到 `id`，再 `{"op":"update","id":"…","patch":{…}}` |
| 11 | 记的物品变成「未命名物品」/名字是整句话 | 名字没抽出来就整句塞了 note | `name` 单独给（"索尼 WH-1000XM5"），原话放 `note` |
| 12 | 生活流多了看不懂的分类 | 把 `cgX/csX` 写进了 `valueRecords.categoryId` | 生活流只认 `clX` |
| 13 | 收入/支出算重了 | 给物品记了一笔 income 又留了 goods.price | 转卖只靠 goods.sellPrice+status retired；买入支出只记一次 valueRecords |
| 14 | 合并后图片变 📦 | 1.7.7 之前的接口断裂（云端引用不被识别） | 已修复；**现在写 cloud 引用是安全的**，别因为怕再回退成 📦 就不用云端图 |
| 15 | `commit` 返回 `committed:0` | items/operations 全是空/非法 | 看返回 `records` 与 `warnings`，检查 amount 是否为数字 |
| 16 | 大 payload 超时 | payload 1MB+ | `--max-time 30`，图片走云端引用（引用只有几十字节） |
| 17 | 日期差一天/差一周 | 规则引擎把「上周五」当今天 | 自己算 `YYYY-MM-DD` 用结构化 `date` |
| 18 | 待入账越积越多、老的消失 | 服务端只留最近 **500 条** pending | 及时让用户合并；你也可以 `inbox/apply` 主动标记已合并（谨慎，优先让用户点合并） |

## 重要规则

- **写入先落「云端待入账」**，记录同时会立刻并入云快照（AI 自己可读回）；用户仍须在 App/网页「AI 接入」页逐条确认并入本机。
- **不要告诉用户"已经入账了"**——只说"已记到云端待入账，去 App/网页合并"。
- 想先看会写什么、不落库：`commit` / `mutate` / `actions/run` 都支持 `"dryRun": true`。
- 写操作前需用户在确认卡片批准；批准被记住则自动执行。
- 查询优先 `POST /api/ai/query`（可控），原生问答用 `POST /api/ai/ask`。
- 自定义：`POST /api/ai/categories` 加分类；`POST /api/ai/options` 加归需选项/判定规则/自定义字段/任意设置；`POST /api/ai/actions` 注册新功能后用 `actions/run` 调用。

## 注意事项

- 密钥只放 config.sh，不写进记忆/聊天/日志。
- 用户描述里没金额时先问清楚，**不要编造**；读不到数据就说"库里没有"，不要猜。
- 拿不准分类时先 `parse`，看服务端怎么判；与用户意图明显冲突（如酸菜被判餐饮、实为食材）→ 用结构化 items 覆盖 `categoryId`。
- 本文所有字段表是**速查**；用户改过分类/字段/归需选项后，**以 `/api/ai/schema` 与 `/api/ai/categories` 为唯一真相**。
- 涉及金额的回答给出**口径**（时间段 + 是否含物品买入支出）。

---

## 附录 A · 内置品牌 glyph（`brand:<slug>`，共 192 个，中文名/拼音/英文名/slug 均可搜）

| 分组 | 可用的 slug / 名称 |
|---|---|
| AI 助手 | claude / deepseek / kimi / moonshot / gemini / perplexity / huggingface / mistralai / ollama / elevenlabs / githubcopilot / openai |
| 云服务 / 网盘 | 阿里云 / icloud / googledrive / dropbox / backblaze / cloudflare / digitalocean / vultr / hetzner / kubernetes / docker / npm / jsdelivr / fastly / vercel / netlify / deno / supabase / firebase |
| 影音 / 视频 | 哔哩哔哩 / 快手 / tiktok / 抖音 / netflix / youtube / youtubemusic / appletv / hbo / twitch / vk / kakaotalk / naver |
| 音乐 / 电台 | 网易云音乐 / spotify / applemusic / soundcloud / bandcamp / tidal / deezer |
| 社交 / 通讯 | 微信 / qq / qq空间 / 微博 / 小红书 / 知乎 / 豆瓣 / telegram / discord / slack / instagram / facebook / x / threads / linkedin / reddit / pinterest / snapchat / whatsapp / line |
| 购物 / 电商 | 淘宝 / aliexpress / amazon / shopee / alibaba / etsy / ebay / target / ikea / 优衣库 / zara / nike / adidas / newbalance / puma / 安踏 |
| 金融 / 支付 | 支付宝 / paypal / visa / mastercard / amex / discover / jcb / wise / stripe / binance / coinbase |
| 游戏 / 娱乐 | steam / epicgames / playstation / xbox / nintendo / riotgames / 米哈游 / 育碧 / ea / rockstargames / itch / gog |
| 硬件 / 数码 | dji / raspberrypi / apple / samsung / 小米 / 华为 / 荣耀 / oppo / vivo / 一加 / 魅族 / 联想 / 华硕 / 微星 / 宏碁 / 戴尔 / 惠普 / nvidia / amd / intel / 高通 / 联发科 / 索尼 / 尼康 / 富士 / 松下 / 徕卡 / 罗技 / 雷蛇 / 赛睿 / hyperx / jbl / bose / 森海塞尔 |
| 开发 / 办公 / 效率 | github / gitlab / gitee / 掘金 / v2ex / jetbrains / neovim / figma / notion / obsidian / canva / adobe / blender / unity / unreal / godot / markdown / todoist / trello / airtable / microsoftoffice / deepl / 多邻国 / wolfram / ao3 / 维基百科 / chrome / edge / safari / arc |
| 出行 / 生活服务 | uber / lyft / airbnb / booking / trip.com / revolut / 星巴克 / 麦当劳 / kfc / burgerking / 可口可乐 / 红牛 / deliveroo / doordash / strava / garmin / fitbit |

> 用法：`image: {"source":"brand","ref":"brand:bilibili"}`，或 `icon: "brand:bilibili"`（订阅/分类的 icon 也收）。
> 不在表里的品牌 → 走「站内图标代理 `/api/icon/img?d=<域名>`」或「下载后上传云端」。

## 附录 B · 版本对照（哪句话在哪个版本才成立）

| 能力 | 版本 | 对 skill 的影响 |
|---|---|---|
| 12 集合通用读写 / schema / query / mutate / options / actions | 1.6.6 | 主体结构没变 |
| AI 写入**自动补默认字段 + 图片归一化**（EntityNormalize） | 1.7.7 | 「必须自己补全全部字段」→ 改为「服务端会补，但你给得更准」 |
| 图片单张上限 2MB、超限拒绝+warning、SVG 拒收 | 1.7.7 | 「压缩到 <200KB」从硬要求降为建议 |
| 待入账即时并入快照 → 有 id 可 `update` | 1.6.5 起（1.7.7 全覆盖） | 「只能撤销重建」→ 改为「有 id 就 update」 |
| `image.source` 枚举 `system/local/web/builtin/brand`（+ cloud） | 1.7.7 / 1.8.0 | 旧 `url/upload/base64` 废弃 |
| 图片云托管 `/api/user/images*`（上传/去重/签名/GC/list） | 1.8.0 | 新增整章 |
| `/api/ai/inbox/apply`、`/api/ai/keys`、`/api/ai/openapi.json` | 1.6.6+ | 端点表补齐 |