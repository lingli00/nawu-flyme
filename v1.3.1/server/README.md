# 纳物 NaWu · PHP 服务端（自托管部署包）

纳物（物品档案 / 订阅管理 / 生活流记账）的自托管服务端。PHP + MySQL，
单站点即可同时服务 **App 端（Capacitor 安卓包）、手机网页版、PC 网页版** 三端。

- 当前版本：网页端 **v1.3.1**（`assets/`）；`storage/app-release/` 内**不含安装包**（空白 manifest，供你自己发布）
- 数据表前缀：**`flyme_`**（安装向导自动建表，无需手动导入 SQL）
- 无任何第三方 Composer 依赖，PHP 7.2 ~ 8.0 原生即可运行

---

## 一、环境要求

| 项 | 要求 |
|---|---|
| PHP | 7.2 ~ 8.0（宝塔默认 7.4 即可），需启用 `pdo_mysql`、`openssl`、`json`，建议有 `mbstring` |
| MySQL | 5.5+（5.6/5.7/8.0 均可） |
| Web | Nginx 或 Apache（二选一，配置文件都已附带） |

## 二、部署步骤（宝塔面板，约 5 分钟）

1. **建站点**：宝塔 → 网站 → 添加站点（PHP 版本选 7.4+，不要创建数据库，下一步向导里连）。
2. **上传解压**：把本包内 `server/` 目录里的**全部内容**上传到站点根目录
   （最终目录结构应是 `站点根/index.php`、`站点根/install.php`、`站点根/app/`……）。
3. **伪静态（漏了必定登不上）**：站点 → 设置 → 伪静态，贴入 `nginx.conf` 末尾「纯伪静态」一段；
   或按 `nginx.conf` 注释合并完整 location 规则。Apache 用户无需操作（`.htaccess` 已带）。
   贴完点「重载配置」。**不加这条的后果**：首页正常、登录页正常，但登录必报「接口不存在」/404。
4. **访问安装向导**：浏览器打开 `http://你的域名/install.php`，按向导 5 步走：
   - 第 1 步：环境自检（全绿才继续）；
   - 第 2 步：填写数据库地址 / 库名 / 用户名 / 密码 → **自动建库建表**（全部表使用 `flyme_` 前缀）；
   - 第 3 步：设置管理员账号密码（用于 `/#/admin` 管理后台）；
   - 第 4 步：站点名称等基础信息；
   - 第 5 步：一键安装完成，向导自动锁定。
5. **打开网站**：`http://你的域名/` 即为网页版；管理后台在 `http://你的域名/#/admin`。

> 重装：删除 `storage/config.php` 后重新访问 `install.php` 即可。

## 三、App 更新渠道（已内置，无需配置）

服务端自带应用更新 API，App 内「设置 → 检查更新」直接可用：

- `GET /api/app/version` → 读取 `storage/app-release/manifest.json` 返回最新版本号与更新说明
- `GET /api/app/download` → 流式下发 `manifest.file` 指定的 APK（文件名固定从 manifest 取，防路径穿越）

**发布新版本 APK 的方法**：把新的 `nawu-vX.Y.Z.apk` 上传到 `storage/app-release/`，
然后修改同目录 `manifest.json` 的 `version` / `notes` / `file` / `fileSize` / `publishedAt` 五个字段即可，
旧版 App 会自动提示升级。`/storage/` 直链已被 Nginx/Apache 规则封锁，下载只能走受控的 API 代理。

> ⚠️ **顺序不能反**：必须**先上传 APK、再改 manifest**。反了会在改完到上传完成之间
> 让 `/api/app/download` 返回 404。

## 四、目录结构

```
server/                ← 把本目录里的全部内容上传到站点根
├── index.php            主入口：/api/* REST + SPA 静态服务 + 图标图片代理
│                        （含「本地品牌图标优先」分支：命中则回 X-Icon-Source: bundled）
├── install.php          安装向导（自动建库建表、写 storage/config.php、初始化管理员）
├── .htaccess            Apache 规则（Nginx 用户参考 nginx.conf）
├── nginx.conf           Nginx/宝塔 配置参考
├── app/
│   ├── Api.php          全部业务 API（用户/同步/备份/管理后台/应用更新）
│   ├── spa-m.html       SPA 壳页面（三端一码）
│   └── lib/             Auth / Config / Db / Mail / Schema / Support
├── assets/              网页前端产物（v1.3.1，含三端样式）
├── brand-icons/         随包品牌图标（177 个，供网页端静态直取 /brand-icons/*）
├── tess/ tessdata/      离线 OCR 资源（App 识图记账用，网页端也会按需加载）
└── storage/             运行时数据（config.php 由向导生成；icon-cache 自动写入）
    ├── brand-icons/     品牌图标本地源（/api/icon/img 优先从这里回图）
    └── app-release/     manifest.json（本包内为空白）+ 你自己发布的安装包
```

## 五、品牌图标机制（v1.0.36 起）

品牌图标不再依赖任何第三方热链，三层保障：

1. **打包资产**：App 与网页端都随包分发 `brand-icons/`，离线可用；
2. **落库引用**：物品/订阅保存的是站内路径 `url:/brand-icons/x.png`（物品与订阅同域名自动共用同一张）；
3. **服务端回源**：`/api/icon/img?d=<domain>` 先查 `storage/brand-icons/`，
   命中直接返回并打标 `X-Icon-Source: bundled`；未命中才回落到远程抓取 + 磁盘缓存。

> ⚠️ `/api/icon/img` 的响应带 30 天 `Cache-Control`，前端调用时统一附带
> `&v=<ICON_CACHE_TAG>` 做缓存击穿。**改了代理内容一定要同步改这个常量值**，
> 否则浏览器/代理会一直吃旧图。

## 六、安全说明

- `storage/` 与 `app/` 已通过伪静态/htaccess 封锁直接访问，数据库密码只存在 `storage/config.php`（不可从 Web 访问）。
- 用户密码为 salted hash 存储；会话走 `flyme_sessions` 表；管理后台独立于用户体系（`flyme_admins`）。
- 建议部署后：宝塔「网站目录」勾选防跨站攻击（open_basedir）；`storage/` 目录确认 PHP 进程可写。

## 七、常见问题

- **安装向导第 2 步连不上数据库**：确认 MySQL 地址（本机填 `127.0.0.1`）、账号密码；数据库不存在时向导会尝试自动创建，权限不足请先在宝塔手动建库。
- **首页能打开，但登录/注册提示「接口不存在」或 404**（最常见的部署失败）：伪静态没生效，
  `/api/*` 没有转发给 `index.php`。站点 → 设置 → 伪静态 贴入
  `try_files $uri $uri/ /index.php?$query_string;` 后点「重载配置」。
  自查：浏览器访问 `http://你的域名/api/health`，应返回 `{"ok":true,"db":true,...}`。
- **页面白屏 / 404**：同上，也是伪静态没生效。
- **品牌图标显示空白**：确认站点根下 `brand-icons/` 已上传（177 个文件），且 `storage/brand-icons/` 可写。
- **验证码/邮件发不出**：管理后台 → SMTP 设置里配置发信邮箱。
- **App 显示「服务器不可达」**：App 端登录页填的是站点 URL（如 `http://你的域名`），确认手机能访问。

---

纳物 NaWu · 网页端产物由 `app/` 里的同一份 React 源码构建而来（见工程根目录 `编译部署与迭代.md`）。
