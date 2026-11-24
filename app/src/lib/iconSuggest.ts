import {
  BRAND_GROUPS,
  type BrandItem,
  iconApiUrl,
  localBrandIconPath,
  normalizeDomainInput,
  searchBrands,
} from './brandIcon';
import { GLYPH_GROUPS, searchGlyphs } from './simpleBrand';

/**
 * ★v1.3.0 图标智能推荐（用户需求：物品/订阅/生活流条目「自动匹配图标」）。
 *
 * 需求原文：
 * - 订阅类优先读取系统本地缓存的 APP 图标（如 B 站等常用软件图标）；
 * - 无本地图标时，根据关键词联网检索图片自动推荐图标；
 * - 交互：弹出卡片默认展示推荐图，满意直接确认保存；不满意一键跳转图片选择页。
 *
 * 推荐链（按优先级，首个即「默认推荐」）：
 * 1. local  —— 随包分发的品牌图标资产（public/brand-icons/，177 个，含 bilibili 等，
 *              APK 与网页都离线可用 = 用户口中的「系统本地缓存的 APP 图标」）；
 * 2. glyph  —— 内置 simple-icons SVG 路径（192 个，零网络，brand: 引用码）；
 * 3. web    —— 自建图标代理（/api/icon/img，服务端抓真实 favicon，需联网）；
 * 4. builtin—— 分类默认 lucide 图标（零匹配时的兜底，绝不留空）。
 *
 * 铁律：本模块只做「推荐什么」，不落库、不渲染；选中后的存取走
 * goodsIcon（物品）/ Subscription.icon（订阅）既有管线。
 */

export type SuggestKind = 'goods' | 'sub' | 'ledger';

export interface IconSuggestion {
  /** icon 三形态值：url:… / brand:… / 裸 lucide id（可直接喂 IconPicker.value）。 */
  value: string;
  /** 展示用 src：/brand-icons/xxx.png、代理 URL、brand: 引用码或 lucide id。 */
  src: string;
  /** 来源标签（徽标文案）：本地图标 / 内置图标 / 网络推荐 / 分类默认。 */
  label: string;
  kind: 'local' | 'glyph' | 'web' | 'builtin';
}

/**
 * 条目名 → 品牌库命中（整词优先，随后前缀逐级缩短）。
 * 「B站大会员」整词搜不中（别名是「b站」）→ 缩到「B站」命中；
 * 「iCloud 50G」→ 缩到「iCloud」命中。前缀策略保证常见
 * 「品牌名 + 修饰词」说法都能推荐，误判时用户可一键更换（推荐层非强制）。
 */
function brandHitFor(kw: string): BrandItem | undefined {
  for (let n = kw.length; n >= 2; n--) {
    const hit = searchBrands(kw.slice(0, n))[0];
    if (hit) return hit;
  }
  return undefined;
}

/** 条目名 → 推荐图标链（去重后按优先级排序，可能为空数组）。 */
export function suggestIcons(
  name: string,
  opts: { kind?: SuggestKind; base?: string; categoryIcon?: string } = {},
): IconSuggestion[] {
  const kw = (name ?? '').trim();
  const out: IconSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: IconSuggestion): void => {
    if (!s.value || seen.has(s.value)) return;
    seen.add(s.value);
    out.push(s);
  };

  if (kw.length >= 2) {
    // ① 品牌库命中（名称/别名/域名）→ 本地打包资产优先，其次代理直链
    const brand = brandHitFor(kw);
    if (brand) {
      const local = localBrandIconPath(brand.domain);
      if (local) {
        push({ value: `url:${local}`, src: local, label: '本地图标', kind: 'local' });
      } else if (opts.base) {
        const api = iconApiUrl(opts.base, brand.domain);
        push({ value: `url:${api}`, src: api, label: '网络推荐', kind: 'web' });
      }
    }
    // ② 名称里抠得出域名（「网易云音乐 music.163.com」）→ 同上
    const domain = normalizeDomainInput(kw);
    if (domain && !brand) {
      const local = localBrandIconPath(domain);
      if (local) {
        push({ value: `url:${local}`, src: local, label: '本地图标', kind: 'local' });
      } else if (opts.base) {
        const api = iconApiUrl(opts.base, domain);
        push({ value: `url:${api}`, src: api, label: '网络推荐', kind: 'web' });
      }
    }
    // ③ 内置品牌 glyph（simple-icons SVG，离线；B站/网易云/极客时间都在）
    const glyph = searchGlyphs(kw)[0];
    if (glyph) {
      push({ value: `brand:${glyph.slug}`, src: `brand:${glyph.slug}`, label: '内置图标', kind: 'glyph' });
    }
  }

  // ④ 分类默认 lucide 图标（兜底：保证卡片上永远有个像样的图）
  if (opts.categoryIcon) {
    push({ value: opts.categoryIcon, src: opts.categoryIcon, label: '分类默认', kind: 'builtin' });
  }
  return out;
}

/** 首个推荐（= 卡片默认展示的那个）；无任何推荐返回 null。 */
export function topSuggestion(
  name: string,
  opts: { kind?: SuggestKind; base?: string; categoryIcon?: string } = {},
): IconSuggestion | null {
  return suggestIcons(name, opts)[0] ?? null;
}

/** 品牌库分组（「不满意 → 跳转选择页」顶部「推荐」入口复用，避免页面再 import 一把）。 */
export { BRAND_GROUPS, GLYPH_GROUPS };
