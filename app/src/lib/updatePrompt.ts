/**
 * ★v1.3.9 应用内更新提醒（启动静默检查 + 全局提醒条）。
 *
 * 背景（用户反馈「APP 怎么没有推送」）：
 * 此前检查更新只在**进入设置页**时静默跑一次（24h 节流），用户不进设置
 * 就永远不知道有新版本；APP 也没有接厂商推送通道（无需常驻后台的轻量
 * 应用不适合上推送 SDK）。所以补一个「启动后静默检查 + 顶部提醒条」，
 * 发新版用户最多晚几小时（节流窗口）就能在应用里看到。
 *
 * 本文件是纯判断/存取（不碰 React），便于单测。
 */

/** 启动检查的节流键：12 小时内不重复请求 manifest（失败也记，别每次启动都等超时）。 */
export const BOOT_CHECK_KEY = 'nawu-app-update-boot-check';
/** 节流窗口（ms）。 */
export const BOOT_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
/** 「这个版本先不提醒了」的键（点 ✕ 后同版本不再弹，更新版本号会重新提醒）。 */
export const DISMISS_KEY = 'nawu-app-update-dismissed';

/** 是否应该做本次启动检查（距上次成功/失败超过节流窗口才查）。 */
export function shouldBootCheck(now: number = Date.now()): boolean {
  let last = 0;
  try {
    last = Number(localStorage.getItem(BOOT_CHECK_KEY) ?? '0') || 0;
  } catch {
    last = 0;
  }
  return now - last >= BOOT_CHECK_INTERVAL;
}

/** 记录「本次启动已检查过」。 */
export function markBootCheck(now: number = Date.now()): void {
  try {
    localStorage.setItem(BOOT_CHECK_KEY, String(now));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 用户上一次主动关掉的提醒对应的版本号（没关过返回 ''）。 */
export function dismissedVersion(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 关掉当前版本的提醒（同版本不再弹；发新版会重新出现）。 */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 是否应该展示提醒条：有可用更新，且用户没关掉过这个版本的提醒。 */
export function shouldPromptUpdate(
  target: { version: string } | null | undefined,
  dismissed: string = dismissedVersion(),
): boolean {
  return Boolean(target) && dismissed !== target!.version;
}
