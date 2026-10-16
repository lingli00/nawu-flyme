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
├── v1.0.34/                     同上（当前最新）
└── README.md                    本文件
```

**每新增一个迭代版本，就新增一个 `vX.Y.Z/` 目录**，内容与上面一致；不要去改动已归档的历史版本目录。

---

## 版本索引

| 版本 | 主要变化 | 目录 |
|---|---|---|
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

## 版本速览（v1.0.34）

| 项 | 值 |
|---|---|
| App 版本 | `1.0.34`（versionCode `42`） |
| 网页版版本 | `1.0.34`（`server/assets/`） |
| 包名 / applicationId | `com.guifou.app` |
| 数据表前缀 | `flyme_` |
| Node / JDK / Android SDK | Node ≥ 20、JDK 17、compileSdk 35 |
| PHP / MySQL | PHP 7.2 ~ 8.0、MySQL 5.5+ |
