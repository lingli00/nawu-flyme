import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { BrandMark } from './BrandMark';

/**
 * 品牌开屏动画（v1.0.17，参考早期开屏方案 + 「显示偏好 → 开屏」开关）。
 *
 * - 实现要点：`SingleTickerProviderStateMixin` 驱动 logo 缩放淡入 → 停留 → 淡出，
 *   本版用 CSS keyframes 复刻同一节奏（700ms 入场 + 停留 + 400ms 淡出）；
 * - **App 每次冷启动都播**；网页端同会话只播一次（sessionStorage），避免刷新一次看一次；
 * - 遵循 `prefers-reduced-motion`；
 * - 结束后整层卸载，不留 DOM、不挡点击。
 */

/** 网页端「本次会话已播过」标记。 */
const SHOWN_KEY = 'gf.splash.shown';

function alreadyShown(): boolean {
  try {
    return window.sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function markShown(): void {
  try {
    window.sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 是否本次需要开屏。 */
export function shouldShowSplash(): boolean {
  if (isNative()) return true; // App：每次冷启动
  return !alreadyShown(); // 网页：同会话仅一次
}

/** 总时长 = 停留 STAY + 淡出 LEAVE。 */
const STAY_MS = 1400;
const LEAVE_MS = 420;

/** 品牌开屏：port 到 body 的最高层，播完自卸。 */
export default function SplashOverlay(): JSX.Element | null {
  const [show, setShow] = useState<boolean>(() => shouldShowSplash());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!show) return;
    markShown();
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stay = reduce ? 500 : STAY_MS;
    const leave = reduce ? 160 : LEAVE_MS;
    const t1 = window.setTimeout(() => setLeaving(true), stay);
    const t2 = window.setTimeout(() => setShow(false), stay + leave);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [show]);

  if (!show) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[120] flex flex-col items-center justify-center bg-paper ${
        leaving ? 'splash-out' : ''
      }`}
      aria-hidden
    >
      {/* 背景光晕（accent 低透明度，深浅色自适应） */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 62%)',
        }}
      />

      {/* Logo：缩放 + 淡入（★v1.0.33 P2-12：自有字标「纳入」意象，替代通用 Compass） */}
      <div className="splash-logo relative mb-6">
        <BrandMark size={104} variant="solid" />
      </div>

      {/* 品牌名 */}
      <div className="splash-up relative text-[30px] font-semibold tracking-[0.32em] text-ink" style={{ animationDelay: '240ms' }}>
        纳物
      </div>
      <div className="splash-up relative mt-2 text-[13px] tracking-[0.18em] text-ink-3" style={{ animationDelay: '400ms' }}>
        NAWU
      </div>

      {/* Slogan + 版本 */}
      <div className="splash-up absolute bottom-[calc(env(safe-area-inset-bottom)+28px)] flex flex-col items-center gap-1" style={{ animationDelay: '620ms' }}>
        <span className="text-[12px] text-ink-3">值得的花销，值得记录</span>
        <span className="text-[11px] text-ink-3/80">v{APP_VERSION}</span>
      </div>
    </div>,
    document.body,
  );
}
