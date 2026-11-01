import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { NaGlyph } from './BrandMark';

/**
 * 品牌开屏 —— 「01 净白印」终稿规范（v1.1.4）。
 *
 * 页面：纯白底 + 极淡 26px 方格；中央苔藓绿方印（108px，rx 26px）白「纳」，
 * 下方品牌名（24px 衬线，字距 .3em）与哲学副文案两行，末尾三色判断点预告。
 * 明暗双版跟随 `<html data-theme>`。
 *
 * 动效五段（总 ≈2.4s，只播一次，可点击跳过）：
 *   ① 点聚  0.00–0.30s  绿点 scale .2→1.0 · opacity 0→1     ease-out
 *   ② 成印  0.30–0.55s  方印 圆角展开 / 缩放回弹至 1.0        ease-out
 *   ③ 落字  0.55–0.90s  「纳」scale .6→1.0 · opacity 0→1     ease-out
 *   ④ 呼吸  0.95–1.35s  整印 scale 1.0→1.06→1.0              ease-in-out
 *   ⑤ 呼气  1.35–1.95s  开屏 translateY 0→−100%（首页 100%→0）ease-in
 *
 * - **App 每次冷启动都播**；网页端同会话只播一次（sessionStorage）；
 * - 遵循 `prefers-reduced-motion`（直接呈现终态 + 短淡出）；
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

/** 方印边长（规范手机稿 108px）。 */
const SEAL = 108;
/** 印内「纳」视觉字面高 = 印高 x 47% x 描边外扩（与 PIL 开屏 PNG 一致）。 */
const NA_INK = SEAL * 0.47 * 1.0237;

/** 呼气段起点 / 时长 / 收尾卸载（规范：①–④ 至 1.35s，⑤ 1.35–1.87s）。
 *  v1.1.4：幕布上移 520ms（与 index.css 的 nawu-splash-exit 保持一致），
 *  卸载留 80ms 余量，避免动画末帧被硬切。 */
const EXHALE_AT = 1350;
const EXHALE_MS = 520;
const UNMOUNT_MS = 1950;

/** 三色判断点（归 / 需 / 否，与 src/domain/stats.ts 一致）。 */
const DOT_COLORS = ['#3f8f6a', '#4a7fb5', '#c2603f'];

/** 品牌开屏：port 到 body 的最高层，播完自卸。 */
export default function SplashOverlay(): JSX.Element | null {
  const [show, setShow] = useState<boolean>(() => shouldShowSplash());
  const [leaving, setLeaving] = useState(false);
  const [dark] = useState<boolean>(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.dataset.theme === 'dark',
  );

  useEffect(() => {
    if (!show) return;
    markShown();
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const exhaleAt = reduce ? 340 : EXHALE_AT;
    const unmount = reduce ? 540 : UNMOUNT_MS;
    const t1 = window.setTimeout(() => setLeaving(true), exhaleAt);
    const t2 = window.setTimeout(() => setShow(false), unmount);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [show]);

  // ⑤ 呼气：首页同步上滑（translateY 100%→0），类挂在 #root 上、播完即摘
  useEffect(() => {
    if (!leaving) return;
    const root = document.getElementById('root');
    if (!root) return;
    root.classList.add('nawu-home-enter');
    const t = window.setTimeout(() => root.classList.remove('nawu-home-enter'), EXHALE_MS + 80);
    return () => {
      window.clearTimeout(t);
      root.classList.remove('nawu-home-enter');
    };
  }, [leaving]);

  if (!show) return null;

  const skip = (): void => setLeaving(true);

  return createPortal(
    <div
      className={`nawu-splash fixed inset-0 z-[120] overflow-hidden${
        dark ? ' is-dark' : ''
      }${leaving ? ' is-leaving' : ''}`}
      onClick={skip}
      role="presentation"
    >
      {/* 极淡方格底纹（26px） */}
      <div className="nawu-splash-grid" aria-hidden />

      {/* 垂直居中单栏：方印 → 品牌名 → 副文案 → 三色点 */}
      <div className="nawu-splash-stage">
        {/* 方印：① 点聚 ② 成印 ④ 呼吸（一个元素三段关键帧） */}
        <div className="nawu-splash-seal">
          {/* ③ 落字 */}
          <div className="nawu-splash-na">
            <NaGlyph ink={NA_INK} color={dark ? '#1a1f1d' : '#ffffff'} />
          </div>
        </div>
        <div className="nawu-splash-brand">纳物</div>
        <div className="nawu-splash-tagline">
          给每一笔支出一个
          <br />
          「归 / 需 / 否」的判断
        </div>
        <div className="nawu-splash-dots" aria-hidden>
          {DOT_COLORS.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </div>
      </div>

      {/* 版本号（安全区底部） */}
      <div className="nawu-splash-ver">v{APP_VERSION}</div>
    </div>,
    document.body,
  );
}
