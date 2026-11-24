/**
 * Skeleton 骨架屏（DESIGN-SYSTEM v1 §4.2）。
 *
 * 加载态优先于 Spinner：用占位块预演真实布局，数据到达后不跳动。
 * shimmer 动画与 prefers-reduced-motion 降级都由 index.css 全局承担
 * （reduce 时动画关闭、底色退化为 --surface-2），组件无需感知。
 */

/** 单个占位块。尺寸与形状由调用方用 className 决定（h-4、w-24、rounded-* 之类）。 */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div aria-hidden className={`shimmer rounded-full ${className}`} />;
}

/** 列表骨架预设：对齐 ListItem 布局节奏（左 40px 圆块 + 标题/副文两行）。 */
export function SkeletonList({
  rows = 3,
  className = '',
}: {
  rows?: number;
  className?: string;
}): JSX.Element {
  return (
    <div aria-hidden className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <div className="shimmer h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="shimmer h-3.5 w-2/5 rounded-full" />
            <div className="shimmer h-3 w-3/5 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
