/**
 * ★v1.8.1 首包瘦身：分类图标「有效 id 集合」的**纯数据模块**（零 lucide 组件导入）。
 *
 * 背景：`categoryIcons.ts` 顶部 import 了 120 个 lucide 图标组件（用于渲染层
 * `CATEGORY_ICON_GROUPS` 的 Icon 引用）。而 `storage/seed.ts` 只用到了其中的
 * `isKnownCategoryIcon()` —— 它仅需判断「这个 id 是否合法」，**根本不需要图标组件**。
 * 但 JS 的静态 import 会把整个 `categoryIcons.ts`（连带 120 个 lucide 组件 ≈ 数百 KB）
 * 一起拉进首包，因为 seed 经 useAppStore 在冷启动就执行。
 *
 * 解法：把 id 列表抽到本文件（纯字符串数组，无任何 lucide import），
 * seed 侧只 import 这里的 `isKnownCategoryIconId`，于是首包不再携带整库 lucide；
 * 真正需要渲染图标组件的页面（HomePage / CategoryPage 等，均为 lazy chunk）
 * 仍从 `categoryIcons.ts` 取，互不影响。
 *
 * 维护约定：新增/删除分类图标时，**同时**更新本文件的 id 列表与
 * `categoryIcons.ts` 的 `CATEGORY_ICON_GROUPS` —— 两者必须保持一致
 * （已有单测 tests 校验映射一致性；若没有，请以 categoryIcons.ts 为准回填本文件）。
 */
export const CATEGORY_ICON_IDS: readonly string[] = [
  'smartphone', 'tablet', 'laptop', 'computer', 'monitor', 'keyboard', 'mouse', 'headphones',
  'headset', 'camera', 'video', 'watch', 'tv', 'speaker', 'gamepad', 'router', 'harddrive', 'usb',
  'battery-charging', 'cable', 'plug', 'cast', 'projector', 'car', 'car-taxi', 'bus', 'plane',
  'helicopter', 'train', 'bike', 'motorbike', 'ship', 'sailboat', 'truck', 'home', 'bed', 'sofa',
  'door-open', 'lamp', 'lamp-desk', 'refrigerator', 'washing-machine', 'air-vent', 'microwave',
  'cooking-pot', 'blender', 'coffee', 'fan', 'gem', 'diamond', 'crown', 'medal', 'ring', 'necklace',
  'ribbon', 'watch-accessory', 'glasses', 'sunglasses', 'dumbbell', 'footprints', 'volleyball',
  'trophy', 'person-standing', 'pill', 'stethoscope', 'heart-pulse', 'bath', 'shirt', 'hard-hat',
  'hand', 'shopping-bag', 'backpack', 'briefcase', 'luggage', 'scissors', 'umbrella', 'toothbrush',
  'soap', 'wind', 'droplets', 'flame', 'sparkles', 'spray-can', 'brush', 'package', 'boxes',
  'glass-water', 'baby', 'book', 'book-open', 'notebook', 'pencil', 'calculator', 'printer',
  'paperclip', 'ruler', 'graduation-cap', 'telescope', 'utensils', 'zap', 'cloud', 'shield',
  'wrench', 'gift', 'tag', 'music', 'guitar', 'piano', 'tickets', 'tent', 'map', 'fish', 'paw-print',
  'flower', 'leaf', 'milk', 'pizza', 'cup-soda', 'chef-hat', 'hammer',
];

const CATEGORY_ICON_ID_SET: Set<string> = new Set(CATEGORY_ICON_IDS);

/** 该值是否为可渲染的已知分类图标 id（纯集合判定，不触碰任何图标组件）。 */
export function isKnownCategoryIconId(id: string | null | undefined): boolean {
  return !!id && CATEGORY_ICON_ID_SET.has(id);
}
