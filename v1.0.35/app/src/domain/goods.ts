import { daysFromToday, isValidDate, today } from '../lib/date';
import { round } from '../lib/money';
import type { Goods } from '../types/entities';

/**
 * 物品领域计算（**纯函数**：只接受数据、只返回派生值，不读 store、不发请求）。
 *
 * 口径：
 * - 总投入 = 购入价 + 附加费用
 * - 净投入 = 总投入 − 转卖收入（退役物品）
 * - 日均成本 = 净投入 / 持有天数（持有天数至少 1，避免除零）
 * - 单次成本 = 净投入 / 使用次数
 */

/** 总投入：购入价 + 所有附加费用。 */
export function totalInvest(g: Goods): number {
  const price = Number.isFinite(g?.price) ? g.price : 0;
  const fees = Array.isArray(g?.extraFees)
    ? g.extraFees.reduce((acc, f) => acc + (Number.isFinite(f?.amount) ? f.amount : 0), 0)
    : 0;
  return round(price + fees);
}

/** 净投入：总投入 − 出售价。 */
export function netInvest(g: Goods): number {
  const sold = Number.isFinite(g?.sellPrice) ? (g.sellPrice as number) : 0;
  return round(totalInvest(g) - sold);
}

/** 持有天数（至少 1 天）。 */
export function holdDays(g: Goods, refDate: string = today()): number {
  const buy = isValidDate(g?.buyDate) ? g.buyDate : refDate;
  const diff = -daysFromToday(buy) + daysFromToday(refDate);
  const days = Math.floor((Date.parse(refDate) - Date.parse(buy)) / 86400000);
  const fallback = Number.isFinite(days) ? days : diff;
  return Math.max(1, fallback + 1);
}

/** 日均成本（元/天）。 */
export function dailyCost(g: Goods, refDate: string = today()): number {
  return round(netInvest(g) / holdDays(g, refDate), 4);
}

/** 单次使用成本（元/次）；未启用计数时按 1 次算。 */
export function perUseCost(g: Goods): number {
  const used = g?.countEnabled ? Math.max(g.usedCount ?? 0, 1) : Math.max(g.usedCount ?? 1, 1);
  return round(netInvest(g) / used, 4);
}

/**
 * 目标达成率 0~1。
 *
 * 语义：`targetDailyCost` 是「我希望这件物品的日均成本不超过多少」，
 * 实际 ≤ 目标即 100%，超过则按 目标/实际 线性衰减。
 */
export function achieveRate(g: Goods, refDate: string = today()): number {
  const target = Number.isFinite(g?.targetDailyCost) ? (g.targetDailyCost as number) : 0;
  if (target <= 0) return 0;
  const actual = dailyCost(g, refDate);
  if (actual <= 0) return 1;
  return Math.max(0, Math.min(1, round(target / actual, 4)));
}

/** 是否已回本（有转卖收入覆盖净投入）。 */
export function isBreakEven(g: Goods): boolean {
  return Number.isFinite(g?.sellPrice) && (g.sellPrice as number) >= totalInvest(g);
}

/** 状态中文标签。 */
export function goodsStatusLabel(status: Goods['status']): string {
  if (status === 'retired') return '已退役';
  if (status === 'favorite') return '心爱';
  return '在用';
}

/** 排序后的物品列表（不修改入参）。 */
export function sortGoods(
  list: Goods[],
  sortBy: 'buyDate' | 'price' | 'dailyCost' | 'name' = 'buyDate',
  refDate: string = today(),
): Goods[] {
  const arr = [...list];
  switch (sortBy) {
    case 'price':
      return arr.sort((a, b) => totalInvest(b) - totalInvest(a));
    case 'dailyCost':
      return arr.sort((a, b) => dailyCost(b, refDate) - dailyCost(a, refDate));
    case 'name':
      return arr.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'zh-CN'));
    case 'buyDate':
    default:
      return arr.sort((a, b) => (b.buyDate ?? '').localeCompare(a.buyDate ?? ''));
  }
}

/** 按状态过滤（退役物品默认不进主列表，由 `includeRetired` 控制）。 */
export function filterGoods(list: Goods[], includeRetired: boolean): Goods[] {
  return includeRetired ? list : list.filter((g) => g?.status !== 'retired');
}

/** 物品库汇总（概览卡片用）。 */
export interface GoodsSummary {
  count: number;
  totalInvest: number;
  netInvest: number;
  /** 在用物品的日均成本合计 */
  dailyCostSum: number;
  retiredCount: number;
}

export function summarizeGoods(list: Goods[], refDate: string = today()): GoodsSummary {
  const active = list.filter((g) => g?.status !== 'retired');
  return {
    count: active.length,
    totalInvest: round(active.reduce((acc, g) => acc + totalInvest(g), 0)),
    netInvest: round(active.reduce((acc, g) => acc + netInvest(g), 0)),
    dailyCostSum: round(active.reduce((acc, g) => acc + dailyCost(g, refDate), 0), 4),
    retiredCount: list.length - active.length,
  };
}
