# 纳物 NaWu · v1.8.0

> 本目录是该版本完整的可编译、可部署工程基线，已脱敏（域名/IP/口令均为占位）。

## 内容

| 路径 | 说明 |
|---|---|
| `app/` | App 端 + 网页端源码（React + TypeScript + Vite + Capacitor） |
| `server/` | 服务端源码（PHP + MySQL，零第三方框架依赖） |
| `tools/` | 构建 / 发布 / 同步脚本（Python / Node） |
| `项目文档/` | 权威项目文档（结构、踩坑、变更日志、部署说明等） |
| `编译部署与迭代.md` | 完整发版与部署操作手册 |
| `纳物-v1.8.0.apk` | 本版 Android 安装包 |

## v1.8.0 主要变化

- 修复 App 启动空白 + 滑动卡顿：**首包 1472KB → 287KB，降 81%**
- 修复筛选栏空滑、底栏遮挡文字、底栏把手交互重做
- 新增整站白屏冒烟测试
- versionCode 90 / versionName 1.8.0

## 脱敏说明

工程内所有真实服务器域名、公网 IP、内网 IP、数据库/面板口令均已替换为占位值：
- 域名 → `your.domain.com`
- 服务器地址 → `your-server-host` / `0.0.0.0`
- 内网地址 → `192.168.1.100`
- 各类口令 → `***`

部署时请按你自有的域名、服务器与数据库信息替换 `server/app/lib/Config.php`（或用 `install.php` 安装向导）与 `app/src/lib/appVersion.ts` 中的更新渠道地址。

## 快速上手

```bash
# 前端依赖与开发
cd app && npm i && npm run dev

# 服务端部署：把 server/ 整个目录上传到站点根，访问 /install.php
```

详细步骤见 `编译部署与迭代.md` 与 `server/README.md`。
