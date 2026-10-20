import type { ReactNode } from 'react';
import { haptic } from '../../lib/haptics';

/**
 * P1-9 · 筛选 / 排序 Chip（首页筛选、报表粒度、生活流四页统一）。
 * 规格：h-8 全圆角；未选 = line 边 + ink-2 字；选中 = accent 边 + accent-soft 底 + accent 字。
 * 样式底座：index.css .nw-chip（data-selected 驱动）。
 */

export function Chip({
  selected,
  onClick,
  children,
  className = '',
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        void haptic('select');
        onClick();
      }}
      data-selected={selected}
      aria-pressed={selected}
      className={`nw-chip ${className}`}
    >
      {children}
    </button>
  );
}

/** 横滑 chip 行（移动端筛选区常用：边缘出血 + 隐藏滚动条）。 */
export function ChipScroller({ children }: { children: ReactNode }): JSX.Element {
  return <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">{children}</div>;
}
