# 纳物 NaWu · Android App

给每一笔支出一个判断：**归**（值了）· **需**（必要）· **否**（冲动）。
物品看日均成本，订阅看下次续费，生活流看归/需/否结构。

技术栈：Vite 5 + React 18 + TypeScript + Tailwind 3 + Zustand + Capacitor 7（Android）。
数据 **100% 本地存储**（Preferences / localStorage），只通过「整体快照备份」上云，
因此与现有 Web 版备份**互相兼容**。

---

## 30 秒上手

```bash
cp .env.example .env.local     # Windows: copy .env.example .env.local
# 把 VITE_DEV_PROXY_TARGET 改成你的纳物后端，例如 http://192.168.1.100:3030
npm install
npm run dev                    # 浏览器 http://localhost:5173
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（Vite 代理 `/api` 到后端） |
| `npm run typecheck` | `tsc --noEmit`，必须零错误 |
| `npm run build` | 类型检查 + 产出 `dist/` |
| `npm test` | 运行 `tests/` 下的单元验证 |
| `npm run check-env` | 构建 APK 前的环境自检（JDK17 / SDK35） |
| `npm run cap:sync` | 构建并同步到 `android/` |
| `scripts\build-android.bat` | 一键出 debug APK |

打 APK 需要 JDK 17 + Android SDK 35，详见 [`docs/BUILD.md`](docs/BUILD.md)。

---

## 目录一眼看懂

```
src/
  types/      数据模型（12 个集合实体 + API DTO + AI 草稿）
  lib/        纯工具：url 归一化 / 日期 / 金额 / ID / emoji / 错误 / 日志
  net/        ★唯一 HTTP 出口：httpClient（CapacitorHttp ⇄ fetch）、errors、aiClient
  api/        后端接口封装：server / auth / backups / user
  storage/    Preferences KV、12 集合仓库、分类种子、快照序列化
  store/      Zustand：App / Server / Auth / Data / Settings / Ui
  domain/     纯函数：ledger / goods / subscription / stats / backupPolicy
  ai/         一句话记账：分句 → AI（OpenAI 兼容）→ 失败回落本地规则
  pages/      页面（当前为占位，T04/T05 交付）
  components/ UI 组件（当前仅 UiHost，T04 交付）
scripts/      check-env.mjs / build-android.bat / build-android.ps1
android/      Capacitor 原生工程（已配好明文 HTTP）
docs/         PRD.md / ARCHITECTURE.md / BUILD.md
```

---

## 三条铁律（改代码前必读）

1. **依赖方向只能向下**：`pages → store → domain/api → net → storage/lib`。
   `pages/**`、`components/**` 内**禁止**裸 `fetch`、禁止直接 import `CapacitorHttp` / `Preferences`。
2. **网络出口唯一**：所有请求走 `src/net/httpClient.ts`。
   POST 请求体一律 JSON（后端只读 `php://input` 做 `json_decode`，form 表单会被静默忽略）。
3. **本地键名与 ID 算法不得改**：`guifou.<collection>`、`guifou.kv.*`、
   `newId() = Date.now().toString(36) + Math.random().toString(36).slice(2,8)`，
   快照 `app` 字段固定 `"guifou-web"`——否则与 Web 版备份无法互通。

---

## 后端兼容性备忘

| 事实 | 工程约束 |
| --- | --- |
| POST 体必须是 JSON | httpClient 无条件设 `Content-Type: application/json` |
| `GET /api/settings` 需要登录 | 引导页不调它取品牌名 |
| `/api/health` DB 挂了也 `ok:true` | 探测时额外看 `db` 字段 |
| 备份列表字段是 `rows`；详情 `payload` 可能是字符串 | 反序列化双兼容 |
| 注册只在服务端要求验证码时才校验 `code` | 注册页自适应：先邮箱+密码，需要时再展开验证码 |
| 服务端**只保留最近 3 份**备份 | UI 常驻提示，自动备份 24h 节流 |

更多细节见 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §0.1。
