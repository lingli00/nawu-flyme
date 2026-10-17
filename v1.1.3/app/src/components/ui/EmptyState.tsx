import type { LucideIcon } from 'lucide-react';
import { Compass } from 'lucide-react';

/**
 * P1-9 / P2-14 · 空态（首页 / 报表 / 生活流统一）。
 *
 * P2-14：引导文案按壳型分流 —— 移动端首屏焦点是底部中央 FAB，桌面端是侧边栏
 * 「记一笔」，旧文案统一写「点右上角＋」指向的是弱势入口。调用方按壳型传 sub
 * （首页用 useShellMode() 判定，勿读 html[data-shell] —— 那是 effect 副作用，首帧不可靠）。
 */

export function EmptyState({
  icon: Icon = Compass,
  title,
  sub,
  actionLabel,
  onAction,
  className = '',
}: {
  icon?: LucideIcon;
  title: string;
  sub?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={`rounded-card border border-dashed border-line bg-surface px-6 py-10 text-center ${className}`}>
      <Icon size={40} strokeWidth={1.5} className="mx-auto text-ink-3" aria-hidden />
      <p className="mt-3 text-sm font-medium text-ink-2">{title}</p>
      {sub ? <p className="mt-1 text-xs leading-5 text-ink-3">{sub}</p> : null}
      {actionLabel && onAction ? (
        <button
          onClick={onAction}
          className="mt-4 inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white active:scale-95"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
