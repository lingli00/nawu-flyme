import type { Judgement } from '../types/entities';
import { hashString } from './id';

/**
 * ★v1.0.3 图标极简化：本模块原来给 AI/新分类分配 emoji 图标，
 * 现在统一返回 lucide 图标 id（词表与 lib/categoryIcons.ts 对齐），
 * 渲染层经 getCategoryIcon()/CategoryGlyph 单色线性输出。
 */

/** 名称关键词 → lucide 图标 id（AI 记一笔建订阅/物品、用户新建分类时给默认图标）。 */
const NAME_ICON_RULES: Array<[RegExp, string]> = [
  [/手机|数码|电脑|平板|相机|耳机|键盘|显示器|魅族|小米|华为|苹果|ipad|iphone/i, 'smartphone'],
  [/衣|裤|鞋|帽|袜|外套|羽绒|裙/, 'shirt'],
  [/家居|沙发|床|桌|椅|收纳|灯/, 'sofa'],
  [/美妆|护肤|口红|粉底|香水|化妆/, 'spray-can'],
  [/厨房|锅|碗|刀|餐具|烘焙/, 'cooking-pot'],
  [/运动|健身|球|跑|瑜伽|户外/, 'volleyball'],
  [/交通|车|自行车|电动车|摩托|地铁|公交|机票|高铁/, 'bus'],
  [/家电|冰箱|空调|洗衣机|电视|微波炉/, 'refrigerator'],
  [/工具|螺丝|钳|电钻|维修/, 'hammer'],
  [/玩具|手办|模型|积木|娃娃/, 'gamepad'],
  [/乐器|吉他|钢琴|尤克里里|鼓/, 'guitar'],
  [/珠宝|首饰|戒指|项链|手表|黄金/, 'gem'],
  [/日用|纸|清洁|洗护|牙膏|洗衣/, 'package'],
  [/影音|视频|会员|音乐|影视|爱奇艺|优酷|b站|netflix/i, 'tv'],
  [/效率|办公|笔记|notion/i, 'zap'],
  [/学习|课程|书|教育|培训/, 'book-open'],
  [/云|服务器|存储|域名|hosting/i, 'cloud'],
  [/游戏|steam|ps|switch|皮肤|点券/i, 'gamepad'],
  [/餐饮|吃|喝|外卖|饭|餐|咖啡|奶茶|零食|水果|菜/, 'utensils'],
  [/居住|房租|水电|物业|燃气|住宿|酒店/, 'home'],
  [/健康|药|医|体检|保险|健身卡/, 'heart-pulse'],
  [/娱乐|电影|演出|ktv|旅游|旅行|门票/, 'headphones'],
  [/人情|红包|礼物|份子|请客/, 'gift'],
  [/通讯|话费|宽带|流量|sim/i, 'headset'],
  [/宠物|猫|狗/, 'paw-print'],
  [/保险|保障/, 'shield'],
];

/** 稳定兜底池（全是 categoryIcons.ts 里的合法 id）。 */
const ICON_ID_POOL: string[] = [
  'smartphone', 'shirt', 'sofa', 'cooking-pot', 'volleyball', 'car', 'refrigerator',
  'hammer', 'gamepad', 'guitar', 'gem', 'package', 'tv', 'zap', 'book-open',
  'cloud', 'utensils', 'home', 'heart-pulse', 'headphones', 'gift', 'tag',
];

/** 根据名称猜一个贴切的图标 id（猜不到就用哈希稳定取一个）。 */
export function emojiForName(name: string): string {
  const text = (name ?? '').trim();
  if (!text) return 'tag';
  for (const [re, icon] of NAME_ICON_RULES) {
    if (re.test(text)) return icon;
  }
  return ICON_ID_POOL[hashString(text) % ICON_ID_POOL.length] ?? 'tag';
}

/** 归 / 需 / 否 的中文标签。 */
export const JUDGEMENT_LABEL: Record<Judgement, string> = {
  gui: '归',
  xu: '需',
  fou: '否',
};

/** 归 / 需 / 否 的 CSS 变量色（禁止在组件里写死色值）。 */
export const JUDGEMENT_COLOR: Record<Judgement, string> = {
  gui: 'var(--gui)',
  xu: 'var(--xu)',
  fou: 'var(--fou)',
};

/** 有序列表，供分段控件 / 选择器遍历。 */
export const JUDGEMENTS: Judgement[] = ['gui', 'xu', 'fou'];

/** 安全的 judgement 转换（AI 返回脏数据时兜底为 'xu'）。 */
export function toJudgement(value: unknown, fallback: Judgement = 'xu'): Judgement {
  return value === 'gui' || value === 'xu' || value === 'fou' ? value : fallback;
}
