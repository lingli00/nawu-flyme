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

/** 横滑 chip 行（移动端筛选区常用：边缘出血 + 隐藏滚动条）。
 *
 *  ★v1.8.0 bug2：横滑行必须同时封住**纵向**。
 *  只写 `overflow-x: auto` 时，浏览器会把这个元素当成一个「纵向也可滚」的容器：
 *  内容只要比自身高 1~2px（chip 折行、放大字号、或本行里带 `my-1` 的分隔条），
 *  手指在这个条上上下滑就能滚出一截空白，也把页面的纵向滚动截走了。
 *  这里统一加 `overflow-y: hidden` + `touch-action: pan-x`：
 *  横向照旧可滑，纵向手势直接透传给外层页面。 */
export function ChipScroller({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto overflow-y-hidden px-4"
      style={{ touchAction: 'pan-x' }}
    >
      {children}
    </div>
  );
}
