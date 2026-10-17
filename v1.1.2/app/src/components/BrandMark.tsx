/**
 * P2-12 · 品牌字标 Logo（v1.0.33）。
 *
 * 旧版用通用 lucide Compass（指南针）—— 与大量工具类 App 撞脸，品牌没有独占记忆点。
 * 新标意象：「纳」= 纳入 —— 上方物件落入下方容器（收纳动作），外框圆角方形容器；
 * 与「纳物」的产品动作（把物品/支出收进来）同构。
 *
 * 三版：
 * - solid   主色版：accent 底 + 白字（开屏 /  favicon / App 图标）
 * - mono    单色版：currentColor 描边（侧边栏深绿底上用反白描边）
 * - inverse 反白版：白底 + accent 字（浅色背景上的小尺寸场景）
 */

export type BrandVariant = 'solid' | 'mono' | 'inverse';

export function BrandMark({
  size = 24,
  variant = 'solid',
  className = '',
}: {
  size?: number;
  variant?: BrandVariant;
  className?: string;
}): JSX.Element {
  const tile =
    variant === 'solid'
      ? { fill: 'var(--accent)' }
      : variant === 'inverse'
        ? { fill: 'var(--surface)' }
        : { fill: 'none', stroke: 'currentColor' };
  const glyph = variant === 'mono' ? 'currentColor' : '#ffffff';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
      focusable="false"
    >
      {/* 外框：圆角方形容器 */}
      <rect x="2.2" y="2.2" width="27.6" height="27.6" rx="9" strokeWidth="2" {...tile} />
      {/* 容器：上开口托盘（收纳的「物」） */}
      <path
        d="M9.5 18.5h13v3a2.5 2.5 0 0 1-2.5 2.5h-8a2.5 2.5 0 0 1-2.5-2.5z"
        fill="none"
        stroke={glyph}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 纳入：向下落入的箭头 */}
      <path
        d="M16 7.5v6.8"
        fill="none"
        stroke={glyph}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12.8 11.6 16 14.9l3.2-3.3"
        fill="none"
        stroke={glyph}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
