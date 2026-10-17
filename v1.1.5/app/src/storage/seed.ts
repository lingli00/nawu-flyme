import type { Category, Settings } from '../types/entities';
import { isKnownCategoryIcon } from '../lib/categoryIcons';
import { getKV, setKV } from './kv';
import { K_SEEDED, KV_SETTINGS } from './keys';
import { loadCollection, saveCollectionNow } from './repo';

/**
 * 默认种子数据。
 *
 * ⚠️ 分类 id 必须与 Web 版一致：`cg0..cg12` / `cs0..cs5` / `cl0..cl23`，共 43 条。
 * 规则：`ledger` 分类可在「分类管理」里增删改排序（v1.0.0 起开放），
 * 首次安装由种子写入；老版本升级由 `mergeSeedCategories()` 按 id 补齐新增项。
 */

/**
 * 「其他」的排序号：固定最大，永远排在生活流分类最后一位。
 * （新分类追加在 order 7..22，所以 999 恒定垫底。）
 */
export const OTHER_LAST_ORDER = 999;

/** 43 条默认分类。 */
export const SEED_CATEGORIES: Category[] = [
  // goods —— cg0..cg12
  { id: 'cg0', name: '数码', icon: 'smartphone', kind: 'goods', order: 0 },
  { id: 'cg1', name: '衣物', icon: 'shirt', kind: 'goods', order: 1 },
  { id: 'cg2', name: '家居', icon: 'sofa', kind: 'goods', order: 2 },
  { id: 'cg3', name: '美妆', icon: 'spray-can', kind: 'goods', order: 3 },
  { id: 'cg4', name: '厨房', icon: 'cooking-pot', kind: 'goods', order: 4 },
  { id: 'cg5', name: '运动', icon: 'volleyball', kind: 'goods', order: 5 },
  { id: 'cg6', name: '交通', icon: 'car', kind: 'goods', order: 6 },
  { id: 'cg7', name: '家电', icon: 'refrigerator', kind: 'goods', order: 7 },
  { id: 'cg8', name: '工具', icon: 'hammer', kind: 'goods', order: 8 },
  { id: 'cg9', name: '玩具', icon: 'gamepad', kind: 'goods', order: 9 },
  { id: 'cg10', name: '乐器', icon: 'guitar', kind: 'goods', order: 10 },
  { id: 'cg11', name: '珠宝', icon: 'gem', kind: 'goods', order: 11 },
  { id: 'cg12', name: '日用', icon: 'package', kind: 'goods', order: 12 },
  // sub —— cs0..cs5
  { id: 'cs0', name: '影音', icon: 'tv', kind: 'sub', order: 0 },
  { id: 'cs1', name: '效率', icon: 'zap', kind: 'sub', order: 1 },
  { id: 'cs2', name: '学习', icon: 'book-open', kind: 'sub', order: 2 },
  { id: 'cs3', name: '云服务', icon: 'cloud', kind: 'sub', order: 3 },
  { id: 'cs4', name: '游戏', icon: 'gamepad', kind: 'sub', order: 4 },
  { id: 'cs5', name: '生活', icon: 'coffee', kind: 'sub', order: 5 },
  // ledger —— cl0..cl23（生活流记账）
  // 前 8 条为老版本既有分类，id 与顺序保持不变，保证老数据不漂移。
  { id: 'cl0', name: '餐饮', icon: 'utensils', kind: 'ledger', order: 0 },
  { id: 'cl1', name: '交通', icon: 'bus', kind: 'ledger', order: 1 },
  { id: 'cl2', name: '居住', icon: 'home', kind: 'ledger', order: 2 },
  { id: 'cl3', name: '学习', icon: 'book-open', kind: 'ledger', order: 3 },
  { id: 'cl4', name: '健康', icon: 'heart-pulse', kind: 'ledger', order: 4 },
  { id: 'cl5', name: '娱乐', icon: 'headphones', kind: 'ledger', order: 5 },
  { id: 'cl6', name: '人情', icon: 'gift', kind: 'ledger', order: 6 },
  // ★v1.0.0 新增 16 条：补齐「买衣服 / 买饰品 / 买食物 / 充话费 / 充游戏 / 云服务」等日常场景
  { id: 'cl8', name: '服饰', icon: 'shirt', kind: 'ledger', order: 7 },
  { id: 'cl9', name: '饰品', icon: 'gem', kind: 'ledger', order: 8 },
  { id: 'cl10', name: '食材', icon: 'milk', kind: 'ledger', order: 9 },
  { id: 'cl11', name: '日用', icon: 'package', kind: 'ledger', order: 10 },
  { id: 'cl12', name: '美妆', icon: 'spray-can', kind: 'ledger', order: 11 },
  { id: 'cl13', name: '数码', icon: 'smartphone', kind: 'ledger', order: 12 },
  { id: 'cl14', name: '通讯', icon: 'headset', kind: 'ledger', order: 13 },
  { id: 'cl15', name: '游戏', icon: 'gamepad', kind: 'ledger', order: 14 },
  { id: 'cl16', name: '云服务', icon: 'cloud', kind: 'ledger', order: 15 },
  { id: 'cl17', name: '宠物', icon: 'paw-print', kind: 'ledger', order: 16 },
  { id: 'cl18', name: '旅行', icon: 'luggage', kind: 'ledger', order: 17 },
  { id: 'cl19', name: '健身', icon: 'dumbbell', kind: 'ledger', order: 18 },
  { id: 'cl20', name: '母婴', icon: 'baby', kind: 'ledger', order: 19 },
  { id: 'cl21', name: '办公', icon: 'paperclip', kind: 'ledger', order: 20 },
  { id: 'cl22', name: '保险', icon: 'shield', kind: 'ledger', order: 21 },
  { id: 'cl23', name: '维修', icon: 'wrench', kind: 'ledger', order: 22 },
  // 「其他」恒定垫底
  { id: 'cl7', name: '其他', icon: 'tag', kind: 'ledger', order: OTHER_LAST_ORDER },
];

/** 默认设置（与 Web 版逐字段一致）。 */
export const SEED_SETTINGS: Settings = {
  baseCurrency: 'CNY',
  currency: 'CNY',
  rates: {},
  ratesUpdatedAt: '',
  includeRetired: false,
  useDepreciation: false,
  theme: 'system',
  palette: 'moss',
  showIcon: true,
  showBuyDate: true,
  showWarrantyCountdown: true,
  formatDaysAsYmd: false,
  vibrate: true,
  splash: true,
  reminderMaster: true,
  homeTab: 'goods',
  viewMode: 'list',
  sortBy: 'buyDate',
  lastBackupAt: '',
  autoSync: true,
  aiEndpoint: '',
  aiKey: '',
  aiModel: 'gpt-4o-mini',
  archivedSubIds: [],
};

/** 复制一份默认设置（避免共享引用被误改）。 */
export function createDefaultSettings(): Settings {
  return { ...SEED_SETTINGS, rates: { ...SEED_SETTINGS.rates } };
}

/** 默认 UI 偏好。 */
export const SEED_UI = {
  offlineMode: false,
  homeTab: 'goods',
  lastRoute: '/home',
};

/** 是否已灌过种子。 */
export async function isSeeded(): Promise<boolean> {
  const flag = await getKV<boolean>(K_SEEDED, false);
  return flag === true;
}

/**
 * ★v1.0.0 分类迁移：把种子里「本地还没有」的分类按 id 追加进去。
 *
 * 老用户（已灌过 27 条种子）不会因为升级丢掉自己的新增/改名/排序，
 * 只补进缺失的新分类；同时把「其他」顶到生活流最后一位。
 *
 * @param existing 本机现有分类
 * @returns 合并后的数组；`changed` 为 true 表示需要落盘
 */
export function mergeSeedCategories(existing: Category[]): { list: Category[]; changed: boolean } {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const missing = SEED_CATEGORIES.filter((c) => !byId.has(c.id));
  let list = existing;
  let changed = false;

  if (missing.length > 0) {
    list = [...existing, ...missing];
    changed = true;
  }

  // ★v1.0.3 图标极简化迁移：种子分类若仍是旧 emoji 图标 → 换成统一 lucide id。
  // ★v1.0.14 补漏：icon 为空或未知值（旧版残留）也一并补成种子图标 ——
  // 只动「非用户自选 lucide 图标」的，名称/排序等用户数据不动。
  const isEmojiIcon = (v: string): boolean => /\p{Extended_Pictographic}/u.test(v);
  for (const seed of SEED_CATEGORIES) {
    const cur = byId.get(seed.id);
    if (cur && cur.icon !== seed.icon && !cur.icon.startsWith('url:') && !cur.icon.startsWith('img:')
      && (isEmojiIcon(cur.icon) || !isKnownCategoryIcon(cur.icon))) {
      list = list.map((c) => (c.id === seed.id ? { ...c, icon: seed.icon } : c));
      changed = true;
    }
  }

  // 「其他」（cl7）恒定垫底：老版本它排在 order 7，会被新分类挤到中间
  const maxOrder = SEED_CATEGORIES.reduce(
    (m, c) => (c.id === 'cl7' ? m : Math.max(m, c.order)),
    0,
  );
  if (byId.get('cl7') && byId.get('cl7')!.order < maxOrder) {
    list = list.map((c) => (c.id === 'cl7' ? { ...c, order: OTHER_LAST_ORDER } : c));
    changed = true;
  }

  return { list, changed };
}

/**
 * 首次启动灌种子：分类 43 条 + 默认设置；已灌过则做增量补齐。
 *
 * 幂等：`flyme.seeded.v1` 存在则跳过；分类为空时也会补灌（防误删后无法使用）。
 * ★Q6：只灌分类与设置，**不灌示例物品/订阅**，避免污染真实备份。
 */
export async function ensureSeeded(): Promise<void> {
  const seeded = await isSeeded();
  const categories = await loadCollection<Category>('categories');

  if (!seeded || categories.length === 0) {
    await saveCollectionNow('categories', SEED_CATEGORIES);
  } else {
    // 老版本升级：补齐 v1.0.0 新增的生活流分类（服饰/饰品/食材/通讯/游戏/云服务…）
    const { list, changed } = mergeSeedCategories(categories);
    if (changed) await saveCollectionNow('categories', list);
  }
  if (!seeded) {
    const settings = await getKV<Settings>(KV_SETTINGS, null);
    if (!settings) await setKV(KV_SETTINGS, createDefaultSettings());
    await setKV(K_SEEDED, true);
  }
}

/** 重置分类为种子（P24「恢复默认分类」用）。 */
export async function resetCategories(): Promise<Category[]> {
  await saveCollectionNow('categories', SEED_CATEGORIES);
  return SEED_CATEGORIES;
}
