import { Capacitor } from '@capacitor/core';

/**
 * 触觉反馈统一出口（v1.0.17，设置 → 显示偏好 → 震动）。
 *
 * 设计要点：
 * - **不读 store**：开关状态由 App 根组件 `setHapticsEnabled()` 注入，避免 `lib → store` 反向依赖
 *   （依赖方向铁律：`pages → store → domain/api → net → storage/lib`）；
 * - 原生走 `@capacitor/haptics`；网页端降级 `navigator.vibrate`（安卓 Chrome 有效，iOS Safari 静默）；
 * - **节流 40ms**：一次操作可能同时触发多条 toast / 多次选中，防手抖式连震；
 * - 全部 `try/catch` 静默：不支持震动的设备/浏览器不应影响业务。
 */

export type HapticKind =
  /** 轻碰：列表点选、切换 Tab */
  | 'light'
  /** 中等：主行动按钮（FAB、AI 记一笔） */
  | 'medium'
  /** 重：长按、拖拽吸附 */
  | 'heavy'
  /** 选择器转动感：切换开关、滑动选择 */
  | 'select'
  /** 成功：保存 / 上传完成 */
  | 'success'
  /** 警告：接近阈值、非阻断提醒 */
  | 'warn'
  /** 失败：网络错误、校验不通过 */
  | 'error';

let enabled = true;
let lastAt = 0;

/** 相邻两次震动的最小间隔（ms）。 */
const THROTTLE_MS = 40;

/** 由 App 根组件按 `settings.vibrate` 注入。 */
export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function isHapticsEnabled(): boolean {
  return enabled;
}

/** 网页端降级用的震动时长（ms）。 */
const WEB_PATTERN: Record<HapticKind, number | number[]> = {
  light: 10,
  medium: 16,
  heavy: 26,
  select: 8,
  success: [12, 45, 18],
  warn: [14, 60, 14],
  error: [18, 50, 26],
};

/** 触发一次震动。 */
export async function haptic(kind: HapticKind = 'light'): Promise<void> {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastAt < THROTTLE_MS) return;
  lastAt = now;
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import('@capacitor/haptics');
      const { Haptics, ImpactStyle, NotificationType } = mod;
      switch (kind) {
        case 'select':
          await Haptics.selectionStart();
          window.setTimeout(() => {
            void Haptics.selectionEnd().catch(() => undefined);
          }, 40);
          break;
        case 'success':
          await Haptics.notification({ type: NotificationType.Success });
          break;
        case 'warn':
          await Haptics.notification({ type: NotificationType.Warning });
          break;
        case 'error':
          await Haptics.notification({ type: NotificationType.Error });
          break;
        case 'medium':
          await Haptics.impact({ style: ImpactStyle.Medium });
          break;
        case 'heavy':
          await Haptics.impact({ style: ImpactStyle.Heavy });
          break;
        default:
          await Haptics.impact({ style: ImpactStyle.Light });
      }
      return;
    }
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate === 'function') nav.vibrate(WEB_PATTERN[kind]);
  } catch {
    /* 设备不支持 → 静默 */
  }
}
