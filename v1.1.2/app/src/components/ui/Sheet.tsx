import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useBackGuard } from '../../lib/backGuard';
import { haptic } from '../../lib/haptics';
import { useMediaQuery } from '../../lib/useMediaQuery';

/**
 * P1-10 · 显式弹层容器（替代全局 CSS hack）。
 *
 * 旧实现用 index.css 的 `.fixed.inset-0.items-end > .sheet-enter` 全局选择器
 * 把底部 sheet 偷偷改成右抽屉 —— 任何新弹层只要类名恰好匹配就会被改写布局，
 * 且抽屉宽度 26rem 写死，20+ 字段的表单（物品编辑）被挤成窄条。
 *
 * 现在：弹层形态由组件 props 显式声明，按断点自动选择：
 * - side="bottom"：移动端底部 sheet（sheet-enter 上滑）；桌面 ≥1024px 转右抽屉，宽 30rem；
 * - side="center"：居中对话框（pop-enter），详情类弹窗用。
 *
 * 已在用的旧弹层仍走全局 CSS 兜底（同样放宽到 30rem），可逐页迁移到本组件。
 */

export type SheetSide = 'bottom' | 'center';

export function Sheet({
  side = 'bottom',
  title,
  onClose,
  children,
  /** 是否由本组件挂返回键守卫（宿主已自有守卫时传 false，避免双重占位历史）。 */
  guard = true,
  /** 桌面抽屉宽度（默认 30rem，复杂表单可传 34rem 支持双列字段）。 */
  drawerWidth = '30rem',
  className = '',
}: {
  side?: SheetSide;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  guard?: boolean;
  drawerWidth?: string;
  className?: string;
}): JSX.Element {
  const wide = useMediaQuery('(min-width: 1024px)');
  const drawer = side === 'bottom' && wide;
  if (guard) useBackGuard(true, onClose);

  const closeBtn = (
    <button
      onClick={() => {
        void haptic('select');
        onClose();
      }}
      aria-label="关闭"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-2 active:scale-95 active:bg-surface-2"
    >
      <X size={16} strokeWidth={2} aria-hidden />
    </button>
  );

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex bg-black/40 ${
        drawer ? 'items-stretch justify-end' : side === 'center' ? 'items-center justify-center p-6' : 'items-end'
      }`}
      onClick={onClose}
    >
      <div
        className={
          drawer
            ? `sheet-enter ml-auto flex h-full max-h-none w-full flex-col overflow-y-auto rounded-l-2xl bg-surface p-5 pb-8 ${className}`
            : side === 'center'
              ? `pop-enter mx-auto flex max-h-[86vh] w-full max-w-sm flex-col rounded-3xl bg-surface ${className}`
              : `sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)] ${className}`
        }
        style={drawer ? { maxWidth: drawerWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-base font-semibold">{title}</p>
            {closeBtn}
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
