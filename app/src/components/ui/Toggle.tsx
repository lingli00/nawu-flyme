import { haptic } from '../../lib/haptics';

/**
 * P1-9 · 开关（消灭 HomePage / SettingsPage 两份复制实现）。
 * 规格：44×26 轨道 + 20 圆点；开 = accent 底；关 = line 边框；knob 位移 180ms；带触觉反馈。
 */

export function Toggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={() => {
        void haptic('select');
        onClick();
      }}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full border transition-colors duration-150 ${
        on ? 'border-accent bg-accent' : 'border-line bg-surface-2'
      }`}
    >
      <span
        className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-all duration-150 ${
          on ? 'left-[22px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}
