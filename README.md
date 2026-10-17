# 纳物 NaWu · Flyme 版

> 纯净的**服务端**与**App 端**完整工程，按版本目录归档。
> 每一次修复迭代都在这里留一份可编译、可部署、可继续迭代的基线。

一套 React 源码 → 两个产物：**Android App**（Capacitor）与**网页版 / PC 版**（Nginx + PHP 托管）。

---

## 目录约定

```
nawu-flyme/
├── v1.0.33/                     ← 每个版本一个目录
│   ├── app/                     App 端工程（React + Vite + TS + Capacitor）
│   ├── server/                  服务端工程（PHP 7.2~8.0 + MySQL，零第三方依赖）
│   ├── tools/sync-web-to-server.mjs   前端产物 → 服务端，一条命令同步
│   └── 编译部署与迭代.md          ★ 完整操作手册，照它做即可
├── v1.0.34/
├── v1.0.35/
├── v1.0.36/
├── v1.1/
├── v1.1.1/
├── v1.1.2/
├── v1.1.3/                   同上（当前最新）
└── README.md                    本文件
```

**每新增一个迭代版本，就新增一个 `vX.Y.Z/` 目录**，内容与上面一致；不要去改动已归档的历史版本目录。

---

## 📦 按版本单独下载（不用整仓下载）

每个版本都打了一个独立的 zip 挂在 **Releases** 里，按需只下载你要的那一个：

| 版本 | 独立下载 |
|---|---|
| v1.1.3 | [nawu-flyme-v1.1.3.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.1.3/nawu-flyme-v1.1.3.zip) |
| v1.1.2 | [nawu-flyme-v1.1.2.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.1.2/nawu-flyme-v1.1.2.zip) |
| v1.1.1 | [nawu-flyme-v1.1.1.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.1.1/nawu-flyme-v1.1.1.zip) |
| v1.1 | [nawu-flyme-v1.1.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.1/nawu-flyme-v1.1.zip) |
| v1.0.36 | [nawu-flyme-v1.0.36.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.0.36/nawu-flyme-v1.0.36.zip) |
| v1.0.35 | [nawu-flyme-v1.0.35.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.0.35/nawu-flyme-v1.0.35.zip) |
| v1.0.34 | [nawu-flyme-v1.0.34.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.0.34/nawu-flyme-v1.0.34.zip) |
| v1.0.33 | [nawu-flyme-v1.0.33.zip](https://github.com/lingli00/nawu-flyme/releases/download/v1.0.33/nawu-flyme-v1.0.33.zip) |

zip 内即是该版本目录的内容（`app/`、`server/`、`tools/`、`编译部署与迭代.md`），解压即用。历史版本请在 [Releases 页](https://github.com/lingli00/nawu-flyme/releases) 挑选。

---

## 版本索引

| 版本 | 主要变化 | 目录 |
|---|---|---|
| **v1.1.3** | ①**卖出盈利计入生活流**：物品标记转卖/填写售价后，有净赚（售价−总投入，含附加费）时自动记一笔收入（改售价同步更新、恢复在用或删除物品自动撤回、亏损不记）；AI 记一笔说「把魅族20卖了1400」也能直接定位物品并完成退役+记账；②**报表页新增「AI 分析」**：本地规则洞察（收支全景/集中度/归需否/趋势/转卖净赚）+ 已配置 API 的 AI 点评，未配置时只出本地洞察、不发请求；③**AI 配置闭环**：AI 记一笔页内嵌设置卡（endpoint/key/model，保存即用），设置页新增「测试连接」按钮，配好 API 即刻生效；④**新品牌图标与开屏**：弃用早期下载的白杯子图，改为自有品牌标（托盘+下落箭头，绿底白字），launcher/round/自适应前景/开屏 11 张全套资源，含 v1.1.2/v1.1.1/v1.1 全部内容 | [`v1.1.3/`](./v1.1.3) |
| **v1.1.2** | ①**修复应用内更新完全不可用**（v1.0.36~v1.1.1 通杀）：`ApkUpdatePlugin` 是 App 本地类（非 npm 包），Capacitor 不会自动注册本地插件，`MainActivity` 漏写 `registerPlugin(ApkUpdatePlugin.class)`，点「立即更新」被桥接层拒绝、报「当前环境不支持应用内更新」——应用内更新链自 v1.0.36 上线起从未在真机跑通（此前被官方频道地址 bug 掩盖）；v1.1.2 修复注册时序（必须在 `super.onCreate()` 之前）并让错误信息透出底层原因；②**修复网页版双入口 bundle**：`spa-m.html` 入口块同步正则从未匹配成功，线上曾同时加载两个版本的 chunk，现正则修复并清理残留；③含 v1.1.1/v1.1 全部内容 | [`v1.1.2/`](./v1.1.2) |
| **v1.1.1** | ①**修复官方更新频道地址 bug**：App 检查更新时请求地址被归一化逻辑剥掉了 `/nawu-update/` 目录，实际拿到的是网页首页而非频道清单，导致官方频道（含 3.2MB 增量补丁）自上线起从未生效、一直提示「已是最新」；现已修复，官方频道恢复优先；②**服务端默认更新源修正**：此前误用脱敏副本打包上线，默认源变成 `127.0.0.1:2233` 被 SSRF 拦截（「连不上更新源」），现改回真实地址并明确「线上包必须从未脱敏源码树出」；③含 v1.1 全部内容（备份 .flyme 加密、昵称同步、移除套餐显示） | [`v1.1.1/`](./v1.1.1) |
| **v1.1** | ①**备份加密**：后台「数据备份/全站备份」导出改为 .flyme 加密容器（FLYME1：PBKDF2 20 万次 + AES-256-GCM，与用户端导出同格式防窃取），导入需同一密码、先本地解密预览再确认，服务端表名/列名白名单 + 事务回滚；②**修复昵称不同步**：管理后台用户列表/名册现在能看到用户端设置的昵称（profiles 单一事实源 + 保存广播同步）；③账号页**移除套餐/会员显示**（纯免费无会员模式）；④正式版本号升至 **1.1**（versionCode 45） | [`v1.1/`](./v1.1) |
| **v1.0.36** | ①**服务端在线更新**：后台一键检查/更新/回滚（manifest 驱动，下载→sha256 校验→备份→解包→应用→清理→自检，协作式分片断点续跑，含数据库迁移），不用再登宝塔；②**App 应用内更新**：官方频道优先 + 增量补丁（NAWU-PATCH1，1.0.35→1.0.36 仅 3.2MB），频道不可达自动回退用户自己的服务器；③后台新增 **App 发布管理**（上传 APK 即更新 manifest，历史版本可回退）；④安全：SSRF 端口白名单参数化、解包路径双保险（safeRelPath + realpath） | [`v1.0.36/`](./v1.0.36) |
| **v1.0.35** | ①报表页「结余/净额」负号修正（此前 -47.59 显示成 47.59 引发误读）+ 点「结余」弹出口径解释；②净值趋势支持点选每期明细与「怎么读」说明，图表有反馈；③生活流无支出占位改为**每日一言**（按日期轮换）；④置物墙改为全屏子页（去掉底部 TabBar，与其它子页一致）；⑤根治「键盘页退出→后台切回后底部大留白」（原生 onResume 复位 WebView 高度 + JS 双拍兜底） | [`v1.0.35/`](./v1.0.35) |
| **v1.0.34** | 补齐**导入备份**功能：用户端「选择 .flyme 文件 → 解密 → 预览 → 恢复到本机」（无需登录即可导入未加密备份），后台管理端新增「导入备份」（合并 / 覆盖两种模式，表名与列名双白名单 + 事务） | [`v1.0.34/`](./v1.0.34) |
| **v1.0.33** | 安全加固：修复服务端与 App 端共 27 项安全风险（越权访问、注入、凭据与日志泄露、接口防刷、上传与路径校验等），加固签名与构建流程。界面与功能与 v1.0.32 一致，可覆盖安装 | [`v1.0.33/`](./v1.0.33) |

---

## 最短路径

### 1) 部署服务端（约 5 分钟，宝塔面板最省事）

把 `vX.Y.Z/server/` 整个目录上传到站点根目录，浏览器访问安装向导：

```
http://你的域名/install.php
```

装完**务必**在宝塔 →「网站 → 设置 → 伪静态」里贴上转发规则：

```nginx
location / {
    try_files $uri $uri/ /index.php?$query_string;
}
```

> ⚠️ **漏了这一步，首页能开、一登录就报「接口不存在 / 404」** —— 因为 Nginx 只处理物理路径，`/api/*` 根本没到 PHP。
> 自查口诀：访问 `http://你的域名/api/health`，返回 `{"ok":true,"db":true,...}` 才算通；
> 返回堡塔自带的 404 页面 = 伪静态没配。

细节见各版本目录下的 `server/README.md`。

### 2) 编译 App

```bash
cd vX.Y.Z/app
npm install
npm run dev                 # 浏览器里先看界面 http://localhost:5173

cd android
./gradlew assembleRelease   # 需先配好签名，见 app/docs/BUILD.md §6
```

### 3) 改完前端后，把新界面同步到网页版（**别漏**）

```bash
cd vX.Y.Z
node tools/sync-web-to-server.mjs
```

`app/src` 是唯一的前端源码。只重打 APK 而忘了同步 `server/assets/`，网页版就会停在旧界面、版本号也会分叉。

---

## 关于这份包「纯净」在哪

- ❌ 无 `node_modules`、无 `dist/`、无 `android/app/build/` 等构建产物（`npm install` 即得）
- ❌ 无**历史安装包**（`server/storage/app-release/` 只留一个空白 `manifest.json`）
- ❌ 无 `server/storage/config.php`（你的数据库口令，安装向导生成）
- ❌ 无 `.user.ini`、无面板默认欢迎页
- ❌ **无签名密钥**（`.p12` / `.jks` / `.keystore` 一律不入库）—— 发布签名密钥请自行生成并放在**仓库外**的口令管理里
- ✅ 我方服务器 IP / 域名 / 站点名已全量脱敏（示例地址统一为 `192.168.1.100`）

## 五条不能破的约定

1. **一套源码两个产物** —— 改完必须 `npm run build` 再 `node tools/sync-web-to-server.mjs`。
2. **网络出口唯一** —— 所有请求走 `app/src/net/httpClient.ts`；POST 一律 JSON（服务端只读 `php://input`）。
3. **本地键名 / ID 算法 / 快照 `app` 字段不得改**（`guifou.<collection>`、`guifou.kv.*`、`newId()`、`app: "flyme-web"`），否则新旧备份不互通。
4. **明文 HTTP 是产品级例外** —— `usesCleartextTraffic` 与 `network_security_config.xml` 是「连内网自建服务器」的必需项，`cap add android` 重建原生工程后必须复查。
5. **签名密钥永不进仓库** —— 口令放仓库外的 `~/.gradle/gradle.properties` 或环境变量。

---

## 版本速览（v1.1.3）

| 项 | 值 |
|---|---|
| App 版本 | `1.1.3`（versionCode `48`） |
| 网页版版本 | `1.1.3`（`server/assets/`） |
| 包名 / applicationId | `com.guifou.app` |
| 数据表前缀 | `flyme_` |
| Node / JDK / Android SDK | Node ≥ 20、JDK 17、compileSdk 35 |
| PHP / MySQL | PHP 7.2 ~ 8.0、MySQL 5.5+ |
