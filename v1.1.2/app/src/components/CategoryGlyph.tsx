import { getCategoryIcon } from '../lib/categoryIcons';

/**
 * 分类图标统一渲染出口（v1.0.3 极简单色化）：
 * - 新数据：Category.icon 存 lucide id（种子已全量迁移）；
 * - 旧数据：emoji / 未知值 → Tag 兜底，绝不抛错；
 * - 全项目任何渲染分类图标的地方都必须走本组件，保证风格统一（单色线性、无彩色底）。
 */
export default function CategoryGlyph({
  id,
  size = 18,
  className,
  strokeWidth,
}: {
  id?: string | null;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const Cmp = getCategoryIcon(id ?? undefined);
  return <Cmp size={size} className={className} strokeWidth={strokeWidth} aria-hidden />;
}
