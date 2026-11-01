/**
 * App 版本常量（问题六 · 应用内一键更新）。
 *
 * ⚠️ 与 `android/app/build.gradle` 的 `versionName` 保持同步：
 * 发新版时两处一起改。服务端 `/api/app/version` 返回的版本大于此值才算有更新。
 *
 * ★版本规范（v1.0.0 起，两端统一）：
 * - 网页端与 App 端**共用同一套版本号**，一起从 `1.0.0` 起步；
 * - 日常改动只递增第三位（修订号）：1.0.0 → 1.0.1 → 1.0.2 …；
 * - 只有主理人明确说「大版本更新」才递增第二位（1.1.0）或第一位（2.0.0）；
 * - 每次改动都要同步：本文件 `APP_VERSION` + `android/app/build.gradle`
 *   （`versionName` 与 `versionCode`）+ `package.json` 的 `version`
 *   + 服务端 `storage/app-release/manifest.json`。
 */
export const APP_VERSION = '1.6.4';

/**
 * 更新渠道（v1.0.36 起；★v1.6.4 改指「自己正在运行的服务端站点根目录」）。
 *
 * App 与自建服务端的「在线更新」统一从这里取：
 * - App 端：优先检查本渠道（含增量补丁），取不到再回退用户自己连接的服务器；
 * - 服务端：管理后台「在线更新」的默认更新源（可在后台改）。
 *
 * ★该地址是唯一硬编码的渠道地址，换服务器只改这一处。
 *
 * ★v1.6.4（本次）：渠道从公共分发目录 `http://106.53.204.29/nawu-update/`
 * 切到**当前正在运行的服务端站点根目录** `https://your.domain.com/`。
 * 这样发布更新只需把两个文件直接丢到网站根目录（FTP / 宝塔文件管理器都行）：
 *
 *   站点根/app-manifest.json   ← 本渠道清单（App 检查更新读它）
 *   站点根/nawu-v1.6.4.apk     ← 安装包本体（清单里写相对文件名即可）
 *   站点根/<旧版>-to-<新版>.patch ← 可选，增量包（有就优先走增量）
 *
 * 目录约定与本地打包工具（tools/update-panel、tools/publish-ota.mjs）一致。
 *
 * ★为什么必须是 https：站点 80 端口对全部请求 301 跳 https（HSTS）。
 * App 端清单请求与 APK 断点续传（Range + 302 跟随）都依赖最终地址稳定，
 * 直接写 https 可以少一次跳转，也避免个别机型在 Range 请求跟随 301 时丢区间。
 *
 * ★v1.4.2：2233 独立端口已下线整合到 80 端口后台，渠道由静态目录提供。
 *
 * ★v1.4.1 修复（重要）：
 * 这里此前一直是 `http://127.0.0.1:2233/nawu-update/` 这个**本地占位地址**，
 * 而构建过程没有任何替换逻辑 —— 手机上的 127.0.0.1 指向手机自己，
 * 官方频道从未连通，每次「检查更新」都静默回退到用户服务器：
 *   · 增量补丁一次都没用上（只能下 14MB 全量包）；
 *   · 用户服务器没同步 manifest 时，直接显示「已是最新版本」。
 */
export const OFFICIAL_UPDATE_CHANNEL = 'https://your.domain.com/';

/**
 * 按 `.` 分段的数字版本比较：`a > b` → 1，`a < b` → -1，相等 → 0。
 *
 * - 缺失段按 0 处理（'0.3' vs '0.3.0' 相等）
 * - 非数字段按 0 处理（'0.3.0-beta' 的第三段是 0）
 * - 前导零无影响（'0.03' 等于 '0.3'）
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? '').trim().split('.');
  const pb = String(b ?? '').trim().split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = parseInt(pa[i] ?? '0', 10) || 0;
    const nb = parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}
