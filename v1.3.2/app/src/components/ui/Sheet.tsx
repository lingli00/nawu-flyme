import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';
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
 * - side="bottom"：移动端底部 sheet（sheet-enter 上滑 + 小把手）；桌面 ≥1024px 转右抽屉，宽 30rem；
 * - side="center"：居中对话框（pop-enter），详情类弹窗用；
 * - side="page"：**移动端整页**（与 /record 等 PageShell 页视觉一致：顶部返回箭头 +
 *   标题、内容区滚动、安全区内边距），桌面仍走右抽屉 —— 用于「新增物品」「新增订阅」
 *   这类字段多的录入表单（v1.1.5：之前它们是小 sheet，而价值记账是整页，
 *   同样是「添加信息」却两种形态，观感割裂）。
 *
 * ★v1.3.1 视觉精致化：底部 sheet 加小把手；标题行统一细分割线；
 * 圆角/阴影三态统一（rounded-t-3xl / rounded-l-3xl / rounded-3xl + shadow-2xl）。
 *
 * 已在用的旧弹层仍走全局 CSS 兜底（同样放宽到 30rem），可逐页迁移到本组件。
 */

export type SheetSide = 'bottom' | 'center' | 'page';

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
  const drawer = (side === 'bottom' || side === 'page') && wide;
  const page = side === 'page' && !wide;
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

  /** ★v1.3.1 底部小把手：可下滑关闭的视觉暗示（与对话抽屉一致的语言）。 */
  const grabber = (
    <div className="flex justify-center pt-2.5 pb-1">
      <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
    </div>
  );

  /** 标题行：与内容之间一道细分割线（对话框/抽屉同一语言）。 */
  const titleRow = title ? (
    <div className="mb-3 flex items-center justify-between gap-3 border-b border-line pb-3">
      <p className="min-w-0 truncate text-base font-semibold">{title}</p>
      {closeBtn}
    </div>
  ) : null;

  /* 整页模式：不用遮罩、不点外部关闭（整屏就是内容），头部换成返回箭头 */
  if (page) {
    return createPortal(
      <div
        className={`nawu-sheet-page fixed inset-0 z-50 overflow-y-auto bg-surface-2 ${className}`}
        style={{
          paddingTop: 'max(env(safe-area-inset-top), 0.5rem)',
          paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
        }}
      >
        <div className="mx-auto w-full max-w-xl px-4">
          <div className="mb-2 flex items-center gap-1.5">
            <button
              onClick={() => {
                void haptic('select');
                onClose();
              }}
              aria-label="返回"
              className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-2 active:scale-95 active:bg-surface"
            >
              <ChevronLeft size={22} strokeWidth={1.8} aria-hidden />
            </button>
            {title ? <p className="min-w-0 truncate text-xl font-bold">{title}</p> : null}
          </div>
          {children}
        </div>
      </div>,
      document.body,
    );
  }

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
            ? `sheet-enter ml-auto flex h-full max-h-none w-full flex-col overflow-y-auto rounded-l-3xl bg-surface p-5 pb-8 shadow-2xl ${className}`
            : side === 'center'
              ? `pop-enter mx-auto flex max-h-[86vh] w-full max-w-sm flex-col rounded-3xl bg-surface p-5 shadow-2xl ${className}`
              : `sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl ${className}`
        }
        style={drawer ? { maxWidth: drawerWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 底部 sheet 才带把手（抽屉/居中对话框无此语言） */}
        {!drawer && side !== 'center' ? grabber : null}
        {titleRow}
        {children}
      </div>
    </div>,
    document.body,
  );
}
