import { haptic } from '../../lib/haptics';

/**
 * P1-9 · 分段控件（物品/订阅 pill、支出/收入切换、主题三选统一）。
 * 规格：h-9 容器 surface-2 底 + line 边；选中项白底滑块 + 600 字重，200ms 过渡。
 * 样式底座：index.css .nw-seg / .nw-seg-item。
 */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
  /** 撑满容器宽度（设置页主题三选等场景）。 */
  block = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  className?: string;
  block?: boolean;
}): JSX.Element {
  return (
    <div className={`nw-seg ${block ? 'flex w-full' : ''} ${className}`} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (!active) void haptic('select');
              onChange(o.value);
            }}
            className={`nw-seg-item ${block ? 'flex-1' : ''}`}
            style={
              active
                ? { background: 'var(--surface)', color: 'var(--ink)', fontWeight: 600, boxShadow: 'var(--shadow)' }
                : { color: 'var(--ink-3)' }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
