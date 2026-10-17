# 纳物 NaWu App · 构建与打包指南

> 面向构建机（有 JDK / Android SDK 的机器）。
> 开发机只需要 Node，跑 `npm run dev` 即可；**不需要** JDK / SDK。

---

## 0. 三件事先讲清楚

1. **浏览器开发不需要 APK**：`npm run dev` + Vite 代理即可连真机后端调试。
2. **APK 只能在有 JDK 17 + Android SDK 的机器上产出**；本仓库已带好 `android/` 工程与一键脚本。
3. **明文 HTTP 是红线**：内网 `http://192.168.1.100:3030` 这类地址，必须依赖 `AndroidManifest.xml`
   的 `usesCleartextTraffic="true"` + `res/xml/network_security_config.xml`。
   这两个文件已在仓库中改好，**改 Android 工程时不要覆盖它们**。

---

## 1. 前置依赖

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | `>= 20`（推荐 22 LTS） | 前端构建；`node -v` 验证 |
| JDK | **17**（Temurin / OpenJDK 均可） | Capacitor 7 + AGP 8.x 的官方要求；JDK 21 可用但不推荐 |
| Android SDK Platform | **35**（Android 15） | `compileSdkVersion 35` |
| Android SDK Build-Tools | **35.0.0** | `android/variables.gradle` 里指定的版本 |
| Gradle | 不需单独装 | 用仓库内 `android/gradle/wrapper` 自带的 wrapper |
| 环境变量 | `JAVA_HOME`、`ANDROID_HOME` | Windows 用户变量，改完需重开终端 |

下载指引：

- JDK 17：<https://adoptium.net/temurin/releases/?version=17>
- Android Studio（含 SDK Manager）：<https://developer.android.com/studio>

Windows 环境变量示例（PowerShell，需重开终端生效）：

```powershell
[Environment]::SetEnvironmentVariable('JAVA_HOME', 'C:\Program Files\Eclipse Adoptium\jdk-17.0.13.11-hotspot', 'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME', "$env:LOCALAPPDATA\Android\Sdk", 'User')
```

---

## 2. 首次在本机跑起来（浏览器）

```bash
cp .env.example .env.local          # Windows: copy .env.example .env.local
# 编辑 .env.local 里的 VITE_DEV_PROXY_TARGET 指向你的纳物后端
npm install
npm run dev                          # http://localhost:5173
```

浏览器里请求 `/api/*` 由 Vite 代理转发到 `VITE_DEV_PROXY_TARGET`，
因此**不会触发 CORS 预检**（后端 `OPTIONS` 返回 404，真机则走原生 `CapacitorHttp`，同样不受影响）。

---

## 3. 首次生成 / 同步 Android 工程

`android/` 目录已随仓库提供，通常无需再 `cap add`。若你删掉了它，或升级 Capacitor 后要重建：

```bash
npm run build
npx cap add android
npx cap sync android
```

> ⚠️ `cap add android` 会**重新生成**原生模板，可能覆盖以下 5 处人工改动。
> 重新生成后请逐项确认（第 4 节），**尤其是明文 HTTP 的两处**。
>
> 另外：`cap add` 在把包名从 `com.getcapacitor.myapp` 改成 `com.guifou.app` 时，
> 若中途被中断，可能在 `android/app/src/**/com/getcapacitor/myapp/` 留下 `*.java.bak`
> 残留文件（Gradle 只编译 `*.java`，不影响构建，但建议删掉）：
> `rm -rf android/app/src/main/java/com/getcapacitor android/app/src/test/java/com/getcapacitor android/app/src/androidTest/java/com/getcapacitor`

---

## 4. 原生工程 5 处人工改动（改动后必须复查）

| # | 文件 | 改动点 |
| --- | --- | --- |
| 1 | `android/app/src/main/AndroidManifest.xml` | `INTERNET` / `ACCESS_NETWORK_STATE` 权限；`android:usesCleartextTraffic="true"`；`android:networkSecurityConfig="@xml/network_security_config"`；`android:windowSoftInputMode="adjustResize"` |
| 2 | `android/app/src/main/res/xml/network_security_config.xml` | **新增**：`<base-config cleartextTrafficPermitted="true">` + `<trust-anchors><certificates src="system" /></trust-anchors>` |
| 3 | `android/variables.gradle` | `minSdkVersion 26`、`compileSdkVersion 35`、`targetSdkVersion 35` |
| 4 | `android/app/build.gradle` | `namespace/applicationId = com.guifou.app`；`versionCode` / `versionName`；`compileOptions` 为 Java 17 |
| 5 | `android/app/src/main/res/values/styles.xml` | `windowTranslucentStatus=false`，状态栏背景跟随主题 |

一键自检（会把缺失项打印出来）：

```bash
node scripts/check-env.mjs
```

---

## 5. 打出 debug APK

```bat
scripts\build-android.bat
```

```powershell
.\scripts\build-android.ps1              # 彩色输出
.\scripts\build-android.ps1 -SkipEnvCheck -UseNpmInstall   # 跳过自检 / 无 lock 文件
```

脚本依次执行：`check-env` → `npm ci` → `npm run build` → `npx cap sync android`
→ `gradlew assembleDebug`，成功后打印：

```
android\app\build\outputs\apk\debug\app-debug.apk
```

---

## 6. 发布签名（release）

> v1.0.33 安全修复后，**签名口令不再写在 `build.gradle` 里**。
> `android/app/build.gradle` 改为从 Gradle 属性 / 环境变量读取下面四个键：
> `NAWU_STORE_FILE`、`NAWU_STORE_PASSWORD`、`NAWU_KEY_ALIAS`、`NAWU_KEY_PASSWORD`。
>
> - 四个键**全都配齐** → release 用你指定的密钥库签名；
> - 一个都没配 → release 构建**直接报错**并打印配置指引（绝不静默用默认口令）；
> - debug 构建 → 回落 Android SDK 自动生成的 debug 签名，日常调试不受影响。

### 6.1 推荐做法：写到仓库外的全局 gradle.properties

口令放在**仓库外**，永远不会被提交：

```
# Windows: C:\Users\<你>\.gradle\gradle.properties
# macOS/Linux: ~/.gradle/gradle.properties

NAWU_STORE_FILE=C:/绝对路径/nawu-flyme/keystore/nawu-release.p12
NAWU_STORE_PASSWORD=见 keystore/README.md
NAWU_KEY_ALIAS=nawu
NAWU_KEY_PASSWORD=见 keystore/README.md
```

然后：

```bash
cd android
./gradlew assembleRelease          # Windows: gradlew.bat assembleRelease
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

工程自带的密钥库在根目录 `keystore/nawu-release.p12`
（`CN=NaWu`，RSA-2048，有效期至 2056-10-05，
证书 SHA-256 `32:CF:BA:0B:AD:7C:07:2A:DA:DD:D7:94:D3:FB:19:51:44:49:76:CF:53:CD:C7:A9:6F:68:6D:C3:43:C7:EC:98`）。
**只要一直用它签名，老用户就能直接覆盖安装升级。**

### 6.2 备选做法：环境变量

```bash
export NAWU_STORE_FILE="keystore/nawu-release.p12"
export NAWU_STORE_PASSWORD="..."
export NAWU_KEY_ALIAS="nawu"
export NAWU_KEY_PASSWORD="..."
cd android && ./gradlew assembleRelease
```

CI（`.github/workflows/build-apk.yml`）走的就是这条路 —— 口令放 GitHub Secrets，
密钥库可选用 `NAWU_KEYSTORE_BASE64` 在构建时落盘。

### 6.3 换一把新签名密钥

```bash
keytool -genkeypair -v -keystore nawu-release.p12 -storetype PKCS12 \
        -alias nawu -keyalg RSA -keysize 2048 -validity 10000
```

> ⚠️ 换 key 后**签名指纹变了，旧版 App 无法覆盖安装**，用户必须卸载重装，
> 应用商店（如有上架）也要走签名迁移流程。没有特别理由不要换。
>
> `*.p12 / *.jks / *.keystore / *.pepk / keystore.properties` 都已在
> `.gitignore` 与 `android/.gitignore` 中忽略 —— **不要把密钥库提交进公开仓库**。

---

## 7. 常见错误排查表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 真机「无法连接到服务器」但地址没错 | 明文 HTTP 被拦 | 检查 Manifest 的 `usesCleartextTraffic` 与 `network_security_config.xml`（第 4 节 1/2 项） |
| 登录报「请输入正确的邮箱地址」 | **POST 请求体不是 JSON** | 后端 `guifou_param()` 只读 `php://input` 做 `json_decode`；所有 POST 必须走 `net/httpClient.ts`（它无条件设 `Content-Type: application/json`），**禁止**裸 `fetch` / form-urlencoded |
| `cap sync` 报版本不一致 | `@capacitor/core` 与 `@capacitor/cli` 版本不同 | 两者必须同为 `7.6.9`，改完删 `node_modules` 重装 |
| `Unsupported class file major version 65` | 用 JDK 21 编了 AGP 8.x | 切到 JDK 17（改 `JAVA_HOME` 后重开终端） |
| `SDK location not found` | 未设 `ANDROID_HOME` | 设置环境变量，或在 `android/local.properties` 写 `sdk.dir=...`（该文件已 gitignore） |
| Gradle 下载卡死 | 默认走 Google 仓库 | 配置国内镜像：在 `android/settings.gradle` 的 `repositories` 里把 `maven { url 'https://maven.aliyun.com/repository/google' }` 放在 `google()` 之前 |
| 改了前端代码但真机没变 | 没同步 | 每次改前端都要 `npm run build && npx cap sync android`；开发期可用 `npx cap run android --livereload` |
| 浏览器里 `/api/*` 返回 `502 upstream connect failed` | Vite 代理连不上后端 | ① 确认后端进程在跑：`curl http://127.0.0.1:3030/api/health`；② 若后端就在本机，把 `.env.local` 的 `VITE_DEV_PROXY_TARGET` 写成 `http://127.0.0.1:3030`（局域网 IP 有时会被防火墙/多网卡拦）；③ 改完 `.env.local` 必须重启 `npm run dev` |
| 状态栏压住内容 | overlay 未关 | `main.tsx` 已调 `StatusBar.setOverlaysWebView({ overlay: false })`；同时检查 `styles.xml` 的 `windowTranslucentStatus=false` |
| 键盘挡住输入框 | 未开 adjustResize | Manifest 的 activity 需 `android:windowSoftInputMode="adjustResize"` |
| 备份列表为空 | 后端字段是 `rows` | `api/backups.ts` 已按 `rows` 解析（不要改成 `backups`） |

---

## 8. Capacitor 8 升级路径（后续项，当前不要做）

当前锁 **Capacitor 7.6.9**（JDK 17 / compileSdk 35 / AGP 8.x）。若后续要升到 8.x：

1. `npm i @capacitor/{core,cli,android}@8` 与各插件的 8.x 版本（core 与 cli 必须同版本）。
2. JDK 升到 **21**，AGP 升到 **8.9+**，`compileSdkVersion` 升到 **36**（先在 SDK Manager 装好）。
3. Kotlin 1.9.x → 2.x：按官方 migration 调整 `android/build.gradle` 的 `kotlinVersion`。
4. `npx cap migrate`（CLI 会给出逐项提示），随后**重新检查第 4 节的 5 处改动**是否被覆盖。
5. 升级后必须回归：内网 http 登录、备份上传/恢复、返回键与状态栏。

---

## 9. 性能与体积基线

| 指标 | 目标 | 检测方式 |
| --- | --- | --- |
| 冷启动本地 hydrate | < 1.5s | 真机 `adb logcat` 看 `hydrate` 耗时，或 Performance 面板 |
| debug APK 体积 | < 25MB | 构建脚本会打印 APK 大小 |
| 首屏 JS | 单 chunk 不超 1.2MB | `npm run build` 的 chunk 告警 |
