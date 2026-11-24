# AI 接入（Muse / 任意智能体）

> 一句话：**拿到 API 地址 + 一把 Key，填进你自己的 AI 后台，之后对 AI 说「午饭 35」它就能帮你记账。**
>
> 服务端版本：v1.6.5 起。网页端/App：我的 → **AI 接入**。

---

## 一、四步接通

### 1. 拿 API 地址

登录纳物（网页端 https://your.domain.com 或 App），进入 **我的 → AI 接入 → 第 1 步**，复制地址：

```
https://your.domain.com
```

接口规范（可直接导入支持 OpenAPI 的平台）：

```
https://your.domain.com/api/ai/openapi.json
```

### 2. 生成 Key

同一页 **第 2 步 → 生成 API 密钥**，得到一串 `nawu_sk_...`。
**明文只显示一次**，请立刻复制。可随时在同一页撤销。

### 3. 填进你的 AI 后台

在 AI 平台里新增「自定义工具 / HTTP 工具 / 插件」，认证方式选 **Bearer**：

| 字段 | 值 |
|---|---|
| Base URL | `https://your.domain.com` |
| 认证 | `Authorization: Bearer nawu_sk_xxx` |
| Content-Type | `application/json` |

工具（4 个，够用；也可以只配前两个）：

| 工具名 | 方法 | 路径 | 入参 | 作用 |
|---|---|---|---|---|
| `nawu_commit` | POST | `/api/ai/commit` | `{"text":"午饭 35"}` | **记账**（AI 只需把原话丢进来） |
| `nawu_ask` | POST | `/api/ai/ask` | `{"question":"这个月花了多少"}` | 查账 / 值不值 |
| `nawu_context` | GET | `/api/ai/context` | — | 取分类、物品库、订阅、最近流水（让 AI 更懂上下文） |
| `nawu_parse` | POST | `/api/ai/parse` | `{"text":"..."}` | 只解析不落库（想先给用户确认时用） |

> `commit` 也接受 AI **自己结构化**的条目（更准，适合强模型）：
> ```json
> {"items":[{"kind":"ledger","type":"expense","amount":35,"categoryName":"餐饮","judgement":"需","date":"2026-11-10","note":"午饭"}]}
> ```
> `kind` 可填 `ledger`（生活流）/ `goods`（物品入库）/ `subscription`（订阅）。

### 4. 记完合并

AI 记的账先落 **云端待入账**。回到 **我的 → AI 接入 → 第 3 步** 点「合并 N 条到本机」，
记录立刻出现在生活流（App / 网页 / 多端一致）。

> 也可以用整份云备份恢复：Muse 的记录会被服务端自动合并进最新快照，
> 且**客户端下次自动备份也不会把它冲掉**（服务端在 `POST /api/sync/push` 时会再合并一次）。

---

## 二、能说什么（示例）

| 你说 | 结果 |
|---|---|
| 午饭 35 | 生活流 · 餐饮 · 支出 35 |
| 昨天买了个耳机 899 | 物品库新增「耳机」+ 一笔 899 支出 |
| 打车花了三十块 | 交通 · 支出 30（中文数字可识别） |
| 腾讯视频月卡 25 | 订阅「腾讯视频」· 25/月 |
| 工资到账 12000 | 收入 12000 |
| 卖了旧手机 1500 | 收入 1500（数码） |
| 这个月花了多少 | 支出/收入/条数汇总 |
| 耳机值不值 | 总投入 / 日均成本 / 达成率 / 结论 |
| 订阅每月多少钱 | 订阅摊销合计 |

解析是**服务端规则引擎**（`server/app/lib/NawuAI.php`），不依赖大模型：
中文数字（含「两千五」）、口语小数（「三块五」）、日期（昨天/前天/3月5日/上周）、
分类关键词（24 类生活流 + 13 类物品）、二手买卖、订阅周期（月/季/年/周）都能处理。

AI 若有更强的结构化能力，直接调 `commit` 传 `items` 即可绕过规则引擎。

---

## 三、curl 自测

```bash
KEY=nawu_sk_xxx

# 记一笔
curl -X POST https://your.domain.com/api/ai/commit \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"text":"昨天买了个耳机 899，今天午饭 35"}'

# 问账
curl -X POST https://your.domain.com/api/ai/ask \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"question":"耳机值不值"}'

# 看云端待入账
curl https://your.domain.com/api/ai/inbox -H "Authorization: Bearer $KEY"
```

想先看会写入什么、不落库：`commit` 加 `"dryRun": true`。

---

## 四、安全

- Key 只属于一个账号，**只能读写你自己**的生活流/物品/订阅（服务端按 owner 隔离）。
- 可随时在「AI 接入」页撤销；撤销后立即 401。
- Key 明文不入库（只存服务端设置表里的一次性映射），泄露就撤销重发。
- 记错了：`DELETE /api/ai/inbox` 传 `{"id":<事件 id>}` 可撤销某一条待入账。

---

## 五、v1.6.6 · 通用数据 API（能调用「所设置的一切」）

> 从「只能记三种固定记录」升级为 **12 个集合 / 116+ 字段全可读写**，且任意集合都允许附加自定义字段。
> 先让 AI 调 `GET /api/ai/schema`，它会拿到完整字段字典，不需要你手工解释。

### 端点一览

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/ai/schema` | GET | 12 个集合的完整字段字典 + 当前归需选项 / 分类 / 自定义功能 |
| `/api/ai/context` | GET | 上下文：物品、订阅、流水、本月收支、每月订阅成本 |
| `/api/ai/collections?name=goods` | GET | 读任意集合（`limit` / `offset` / `filter`） |
| `/api/ai/query` | POST | 多条件查询：`filter` 支持 `$gte/$lte/$contains/$in/$or`，可排序 / 投影 / 分页 |
| `/api/ai/mutate` | POST | **通用写入**：`upsert` / `update` / `delete` / `replace` 任意集合任意字段 |
| `/api/ai/commit` | POST | 兼容旧用法；`items` 里用 `collection` 可指定任意集合、全字段透传 |
| `/api/ai/categories` | GET/POST/DELETE | 自行添加 / 删除生活流、物品、订阅分类 |
| `/api/ai/options` | GET/POST | 自定义「是否归需」选项、判定规则、自定义字段、任意设置 |
| `/api/ai/actions` | GET/POST/DELETE | 注册 / 删除**任意新功能** |
| `/api/ai/actions/run` | POST | 调用自定义功能 |
| `/api/ai/inbox` | GET/DELETE | 待入账明细 / 撤销（撤销时同步清掉云快照里的记录） |

### 写一条「全字段」的物品

```bash
KEY=nawu_sk_xxx
curl -X POST https://your.domain.com/api/ai/mutate \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "operations":[{
      "op":"upsert","collection":"goods",
      "record":{
        "name":"显示器","price":1299,"currency":"CNY","buyDate":"2026-11-10",
        "note":"双十一，送了根线","warrantyDate":"2029-11-10",
        "extraFees":[{"name":"运费","amount":20},{"name":"手续费","amount":5}],
        "feeRatePermille":21,
        "image":{"source":"url","ref":"https://example.com/photo.jpg"},
        "purchaseChannel":"京东"
      }
    }]
  }'
```

`purchaseChannel` 是没在字典里声明的自定义字段，照样原样存下来。
订阅的「每个月多少钱」= `amount:25, period:"month", every:1`；截止时间用 `endDate`（账单用 `dueDate`）。

### 自定义「是否归需」与分类

```bash
# 增加一个自定义归需选项 + 关键词规则
curl -X POST https://your.domain.com/api/ai/options \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "judgementOptions":[{"value":"tun","label":"囤 · 囤货","aliases":["囤","囤货"],"color":"#b98a1f"}],
    "judgementRules":[{"value":"fou","keywords":["冲动","又买了"]}],
    "customFields":[{"collection":"goods","name":"purchaseChannel","type":"string","label":"购买渠道"}],
    "settings":{"myCustomFeature":{"enabled":true}}
  }'

# 自行添加一个生活流分类（物品用 goods，订阅用 sub）
curl -X POST https://your.domain.com/api/ai/categories \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"kind":"ledger","name":"咖啡","icon":"coffee","order":99}'
```

内置归需值是 `gui`(归·值得) / `xu`(需·必要) / `fou`(否·本可避免)；
中文「归」「需」「否」与自定义别名都会自动归一，写进本机后生活流能正常显示。

### 注册「任意新功能」

```bash
curl -X POST https://your.domain.com/api/ai/actions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "name":"记咖啡","description":"记一笔咖啡支出",
    "params":[{"name":"amount","type":"number","required":true},{"name":"note","type":"string"}],
    "operations":[{"op":"upsert","collection":"valueRecords","record":{
      "type":"expense","amount":"{{amount}}","date":"2026-11-10",
      "categoryId":"cl0","judgement":"xu","note":"{{note}}"
    }}]
  }'

# 调用
curl -X POST https://your.domain.com/api/ai/actions/run \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"记咖啡","params":{"amount":18,"note":"拿铁"}}'
```

`{{参数名}}` 会在调用时替换（数字保持数字类型）。`dryRun:true` 可先预演不落库。

### 关于「云端待入账」

- AI 的每次写入先落云端「待入账」，**不会直接改你本机数据**；
- 网页 / App 的「AI 接入 → 第 3 步」默认展开，逐条显示集合、名称、金额、日期与字段；
- 默认不勾选，确认后点「合并选中 N 条」才写进本机；不想入账的可点「丢弃」；
- 撤销一条时，服务端会同步把该记录从云端快照里剔除，不留残账。

### 给 AI 的提示词

「AI 接入」页 → 接口能力 → **复制能力说明（粘贴给 AI）**，
内容包含 Base URL、鉴权、全部端点与可写字段，省得自己写系统提示词。
