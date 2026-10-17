# 纳物 App 源码 · v1.0.33（新 UI + 安全修复）

本目录是 `../纳物-App-源码-v1.0.32/`（UI 优化版）的**完整源码副本**，
已把上一轮安全审计中 **App 端涉及的问题**全部套用修复。UI 改动与本轮前一致，未回退。

> 只想拿补丁的话：改动集中在下面 7 个文件，可对照覆盖到你的原项目；
> 想直接用的话：本目录本身就是可构建的完整工程。

## 〇、v1.0.33 版本号同步（本次发布）

按 `src/lib/appVersion.ts` 的版本规范，四处已一并升到 `1.0.33`：

| 位置 | 值 |
|---|---|
| `src/lib/appVersion.ts` → `APP_VERSION` | `1.0.33` |
| `android/app/build.gradle` → `versionName` / `versionCode` | `1.0.33` / `41` |
| `package.json` / `package-lock.json` → `version` | `1.0.33` |
| 服务端 `storage/app-release/manifest.json` | 待 APK 产出后同步（见文末） |

⚠️ `APP_VERSION` 同时被**网页版**引用（`MainShell` / `MePage` / `SettingsPage` / `SplashOverlay`
显示为「纳物 · App/网页版 v1.0.33」）。改它会改变 `dist/` 产物哈希，因此
**服务端的 `assets/` 与 `app/spa-m.html` 必须一起更新**，否则网页版与 App 版本号会分叉。

---

## 一、改动清单

| 文件 | 审计项 | 改动 |
|---|---|---|
| `android/app/build.gradle` | **S1 严重** | 删除硬编码的 `storePassword '（口令见仓库外密钥管理）'` 等；签名口令改为从 `NAWU_*` 属性 / 环境变量读取。未配置时 **release 构建直接报错**（绝不静默用默认口令），debug 回落 Android SDK 的 debug 签名 |
| `android/gradle.properties.template` | S1 配套 | 新增：签名配置模板，并纠正上一版的错误指引（口令要放**仓库外**的 `~/.gradle/gradle.properties` 或环境变量，**不是**仓库内的 `android/gradle.properties`） |
| `.github/workflows/build-apk.yml` | S1 配套 | CI 改为从 GitHub Secrets 注入签名口令；密钥库可用 base64 secret 落盘 |
| `.gitignore` | **S1 配套（本轮新增）** | 忽略 `*.p12 / *.jks / *.keystore / *.pepk / keystore.properties`——**这是上轮遗漏**：旧密钥库当年正是因为没有忽略规则才随仓库分发出去 |
| `android/.gitignore` | **S1 配套（本轮新增）** | 上游模板默认把密钥库忽略规则**注释掉**，现取消注释 |
| `android/app/src/main/AndroidManifest.xml` | M5 中危 | `android:allowBackup="true"` → `"false"`，关闭 adb backup / 云备份对应用私有数据（登录 token 等）的整体导出 |
| `android/app/src/main/res/xml/network_security_config.xml` | M6 中危* | 保留内网明文放行（产品级例外，理由见文件内注释），补齐安全说明与一键收紧指引 |
| `src/api/endpoints.ts`、`src/types/api.ts`、`src/lib/flymeFile.ts` | **L9 低危（本轮新增）** | 清除注释里残留的开发机绝对路径 `D:/wwwroot/...` |

\* M6 明文流量为**产品级例外**：纳物的核心功能是「局域网扫描 + 用户自建服务器」，
Android 的网络安全配置不支持 CIDR 网段通配，无法既放行私网又禁明文。
已在文件注释里写明原因、已采取的收紧措施与「一键改 https-only」的方法。

---

## 二、构建 / 使用

```bash
# 0) 依赖（本副本未带 node_modules）
npm ci

# 1) 配置签名口令（二选一，详见 android/gradle.properties.template）
#    A. 本地构建：写入 ~/.gradle/gradle.properties（仓库外，永不提交）
#       NAWU_STORE_FILE=nawu-release.p12
#       NAWU_STORE_PASSWORD=<你的新口令>
#       NAWU_KEY_ALIAS=nawu
#       NAWU_KEY_PASSWORD=<你的新口令>
#    B. 环境变量：同上四个键名，export 即可

# 2) 构建
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease
```

未配置签名时：`assembleRelease` 会**直接失败并提示**（避免误用默认口令打出版本）；
`assembleDebug` 仍可正常调试（回落 SDK debug 签名）。

---

## 三、⚠️ 运维必做（代码改不掉的）

旧签名密钥 `nawu-release.p12` 曾随仓库分发、口令 `（口令见仓库外密钥管理）` 曾硬编码在
`build.gradle` —— 两者应视为**已泄露**。仅改构建脚本不够：

1. `keytool -genkeypair` 生成一把**新** `.p12`（新口令），替换旧密钥；
2. 在分发渠道（应用宝 / 官网 / Google Play）完成签名迁移；
3. 清理 git 历史里的旧密钥文件与明文口令（`git filter-repo` 或 BFG）；
4. 把旧 key 正式作废。

在新密钥生效前，任何拿到旧仓库的人都能签发可覆盖安装的「正版升级包」。

> **2026-10-16 复核补充**：`你的账号/你的仓库` 当前为**公开仓库**（非私有），
> 因此 `android/app/nawu-release.p12` 与口令 `（口令见仓库外密钥管理）` 不是「小范围可见」，
> 而是**任何人无需登录即可下载**。这使第 1 步（换密钥）的紧迫度从「建议」上升到「必须」。
> 在旧 key 作废前，请不要把新版本发布到任何公开分发渠道。

---

## 四、App 端剩余项（本轮未做，属产品/后续决策）

| 项 | 说明 |
|---|---|
| L4 | `minifyEnabled false`，release 未开混淆，APK 内 JS 可被直接读取（开启需评估 Capacitor 的 keep 规则） |
| L8 | 登录 token 明文存 SharedPreferences / localStorage（接 `EncryptedSharedPreferences` 需新增原生插件） |
| L10 | `push-api.cjs` 注释含私有仓库名（token 走环境变量，无实际泄露，确认仓库为私有即可） |
