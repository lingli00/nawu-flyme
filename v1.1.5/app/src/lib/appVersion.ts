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
export const APP_VERSION = '1.1.5';

/**
 * 官方更新频道（v1.0.36 起）。
 *
 * App 与自建服务端的「在线更新」统一从这里取：
 * - App 端：优先检查本频道（含增量补丁），取不到再回退用户自己的服务器；
 * - 服务端：管理后台「在线更新」的默认更新源（可在后台改）。
 *
 * ★该地址是唯一硬编码的官方地址，换服务器只改这一处。
 */
export const OFFICIAL_UPDATE_CHANNEL = 'http://127.0.0.1:2233/nawu-update/';

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
