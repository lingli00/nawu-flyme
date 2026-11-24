# 纳物 NaWu

> 给每一笔支出一个判断：**归**（值了）· **需**（必要）· **否**（冲动）。
> 个人物品与消费复盘应用 —— 手机 App、网页版、微信小程序，一套 React 源码出三端 + 自建 PHP 服务端。

本仓库是纳物**最新版（v1.8.0）的完整可编译、可部署工程**，已脱敏（域名 / IP / 口令均为占位）。历史版本不在此归档，只保留当前最新基线。

---

## 📦 仓库内容

| 路径 | 说明 |
|---|---|
| `app/` | **App 端 + 网页端源码**：React 18 + TypeScript 5 + Vite 5 + Tailwind 3 + Zustand + Capacitor 7（Android） |
| `server/` | **服务端源码**：PHP 8 原生（零第三方框架依赖）+ MySQL（表前缀 `flyme_`） |
| `tools/` | 构建 / 发布 / 同步脚本（Python / Node）：一键同步前端产物到服务端、出 APK、发更新渠道 |
| `项目文档/` | 权威项目文档：项目结构、踩坑清单、变更日志、部署说明、AI 接入等 |
| `编译部署与迭代.md` | 完整发版与部署操作手册（照它做即可上线） |
| `README.md` | 本文件 |

**Android 安装包**见右侧 **Releases**：`纳物-v1.8.0.apk`（v1.8.0 版，直接下载安装）。

---

## ✨ v1.8.0 主要变化

- **修复 App 启动空白 + 滑动卡顿**：首屏代码按路由拆分，首包 1472KB → 287KB（降 81%）
- **修复横向滑动跟手**：左右滑页时两页各露一半、随手指实时联动，甩快不再白屏
- **修复底栏遮挡 / 空滑**：底栏高度实测自适应，内容不再被压住；折叠把手改为可点可甩的胶囊
- **底栏液态玻璃高亮块跟手滑动**：切 Tab 时高亮块随页面一起平移、暂停同步
- 新增整站白屏冒烟测试；versionCode 90 / versionName 1.8.0

---

## 🚀 快速上手

### 前端 / App

```bash
cd app
cp .env.example .env.local     # 把 VITE_DEV_PROXY_TARGET 改为你的纳物后端地址
npm install
npm run dev                    # 浏览器开发预览
npm run build                  # 产出 dist/
```

打 Android APK 需要 JDK 17 + Android SDK 35，详见 `app/docs/BUILD.md`。

### 服务端

把 `server/` 整个目录上传到你的站点根，访问 `/install.php` 走安装向导，或按 `项目文档/` 手工配置 `server/app/lib/Config.php`（数据库连接等）。

---

## 🔒 脱敏说明

本仓库为**脱敏版**：所有真实服务器域名、公网 / 内网 IP、数据库与面板口令均已替换为占位值 ——

- 域名 → `your.domain.com`
- 服务器地址 → `your-server-host` / `0.0.0.0`
- 内网地址 → `192.168.1.100`
- 各类口令 → `***`

部署时请替换为你**自有**的域名、服务器与数据库信息（`server/app/lib/Config.php` 或 `/install.php` 安装向导），以及 `app/src/lib/appVersion.ts` 里的更新渠道地址。

> 语音识别（vosk）与 OCR（tesseract）的运行时模型文件较大，未纳入本仓库，需按 `app/docs/BUILD.md` / `项目文档/` 从官方渠道下载后放入对应目录。

---

## 📄 许可

个人项目，源码仅供学习与自用参考。
