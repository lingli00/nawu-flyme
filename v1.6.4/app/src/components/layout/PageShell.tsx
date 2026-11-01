import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 通用子页面壳：顶栏（返回 + 标题 + 右侧动作） + 滚动内容区。
 * 业务子页（非底部 Tab 页）都套它，保证一致的页头与安全区。
 *
 * ★v1.3.2 `flushOnDesktop`：电脑网页版里，登录 / 账号编辑这类「独立整页」
 * 原来会把 bg-surface-2 铺成一块**方角白板**，浮在纸色背景上很扎眼
 * （用户反馈「卡片没有圆角」）。开启后桌面端不再铺底色，
 * 内容卡片直接落在纸色背景上，与首页/报表等页面同一观感。
 */
export default function PageShell({
  title,
  subtitle,
  onBack,
  right,
  children,
  flushOnDesktop = false,
}: {
  title: string;
  subtitle?: string;
  /** 不传则默认 navigate(-1) */
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
  /** 桌面端不铺 surface-2 底色（独立整页用，避免方角白板）。 */
  flushOnDesktop?: boolean;
}) {
  const nav = useNavigate();
  const back = onBack ?? (() => nav(-1));

  return (
    <div
      className={`min-h-full text-ink ${flushOnDesktop ? 'nw-page-flush bg-surface-2 dt:bg-transparent' : 'bg-surface-2'}`}
    >
      <header
        className="sticky top-0 z-20 flex items-center gap-2 border-b border-line px-3"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          background: 'color-mix(in srgb, var(--surface) 62%, transparent)',
          backdropFilter: 'blur(24px) saturate(170%)',
          WebkitBackdropFilter: 'blur(24px) saturate(170%)',
        }}
      >
        <button
          onClick={back}
          className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-btn text-xl text-ink-2 active:bg-surface-2"
          aria-label="返回"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1 py-2.5">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {subtitle ? <p className="truncate text-xs text-ink-3">{subtitle}</p> : null}
        </div>
        {right ? <div className="flex shrink-0 items-center">{right}</div> : null}
      </header>
      <main className="mx-auto w-full max-w-xl px-4 pb-10 pt-3">{children}</main>
    </div>
  );
}
