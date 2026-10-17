import type { Goods, GoodsImage } from '../types/entities';

/**
 * 物品图标单一真相源（v1.0.29 · 「选系统图标无效」根治）。
 *
 * 背景：物品的图片是对象形态 `{ source, ref }`，而 IconPicker 输出的是
 * 三形态字符串（裸 lucide id / `url:` / `img:`）。此前转换逻辑散落在
 * HomePage 内联函数与 shareCard 各写一份：
 * - HomePage 的 `onIconChange` 遇到裸 lucide id 直接 `setImage(undefined)`
 *   → 用户在「系统图标」里点什么都选不中（永远回落分类图标）；
 * - shareCard 的 `goodsIconValue` 缺 builtin 分支 → 分享海报 / 置物墙丢图；
 * - 列表卡与详情弹窗硬编码 `url:${ref}` → 本地图之外的形态全渲染错。
 *
 * 铁律：凡是 Goods.image ↔ icon 字符串互转，一律走这里的两个函数，别再内联。
 */
export type GoodsIconSource = 'local' | 'web' | 'brand' | 'builtin' | (string & {});

/** ref 是否本地 dataURL 图。 */
export function isLocalImage(g: { image?: GoodsImage }): boolean {
  return Boolean(g.image?.ref && g.image.ref.startsWith('data:'));
}

/** ref 是否网络图标（http(s) 直链 / `url:` 前缀）。 */
export function isWebImage(g: { image?: GoodsImage }): boolean {
  const ref = (g.image?.ref ?? '').trim();
  if (!ref) return false;
  return ref.startsWith('http') || ref.startsWith('url:');
}

/**
 * Goods.image → icon 字符串（img:/url:/brand:/裸 lucide id）。
 * ★builtin 分支是 v1.0.29 新增：`source:'builtin'` 的 ref 就是 lucide id，
 * 直接透传给 IconPreview / IconPicker 即可选中并渲染。
 */
export function goodsIconValue(g: Pick<Goods, 'image'>): string {
  const img = g.image;
  const ref = (img?.ref ?? '').trim();
  if (!ref) return '';
  if (ref.startsWith('brand:')) return ref; // v1.0.19 内置品牌引用码
  if (img?.source === 'local' || ref.startsWith('data:')) return `img:${ref}`;
  if (img?.source === 'web' || ref.startsWith('url:') || /^https?:\/\//i.test(ref)) return `url:${ref}`;
  if (img?.source === 'builtin') return ref;
  return '';
}

/**
 * icon 字符串 → Goods.image（可能为 undefined = 无自定义图标，回落分类图标）。
 * 裸 lucide id 落到 `source:'builtin'`，不再被丢掉。
 */
export function goodsImageFromIcon(v: string): GoodsImage | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  if (s.startsWith('brand:')) return { source: 'brand', ref: s };
  if (s.startsWith('img:')) return { source: 'local', ref: s.slice(4).trim() };
  if (s.startsWith('url:')) return { source: 'web', ref: s.slice(4).trim() };
  return { source: 'builtin', ref: s };
}

/** 物品是否有自定义图标（区别于「回落分类图标」）。 */
export function hasOwnIcon(g: Pick<Goods, 'image'>): boolean {
  return goodsIconValue(g) !== '';
}
