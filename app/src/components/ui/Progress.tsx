/**
 * Progress 进度条（DESIGN-SYSTEM v1 §4.2）。
 *
 * 收编 SmartRecordDock 手写的 `h-[6px]/h-[3px] overflow-hidden rounded-full` 圆条。
 * role="progressbar" + aria-valuenow 让屏幕阅读器可感知进度；
 * 宽度过渡走 300ms（全局 --transition-normal 档），进度回退同样平滑。
 */

export function Progress({
  value,
  label,
  size = 'md',
  className = '',
}: {
  /** 0–100；超出范围会被钳制 */
  value: number;
  /** 无可见文字时的无障碍名称（必填于无标题场景） */
  label?: string;
  /** md = 6px（卡片内主进度），sm = 3px（行内细进度） */
  size?: 'sm' | 'md';
  className?: string;
}): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
      className={`w-full overflow-hidden rounded-full bg-surface-2 ${
        size === 'sm' ? 'h-[3px]' : 'h-1.5'
      } ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
