import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 通用子页面壳：顶栏（返回 + 标题 + 右侧动作） + 滚动内容区。
 * 业务子页（非底部 Tab 页）都套它，保证一致的页头与安全区。
 */
export default function PageShell({
  title,
  subtitle,
  onBack,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  /** 不传则默认 navigate(-1) */
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
}) {
  const nav = useNavigate();
  const back = onBack ?? (() => nav(-1));

  return (
    <div className="min-h-full bg-surface-2 text-ink">
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
