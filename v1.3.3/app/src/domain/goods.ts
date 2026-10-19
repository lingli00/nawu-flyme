import { isValidDate, today } from '../lib/date';
import { round } from '../lib/money';
import type { Goods } from '../types/entities';

/**
 * 物品领域计算（**纯函数**：只接受数据、只返回派生值，不读 store、不发请求）。
 *
 * 口径：
 * - 总投入 = 购入价 + 附加费用
 * - 净投入 = 总投入 − 转卖收入（退役物品）
 * - 转卖净赚 = 出售价 − 总投入（仅正数入生活流，见 useDataStore.syncSaleIncome）
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

/**
 * ★v1.1.3 转卖净赚：出售价 − 总投入。
 *
 * 口径与首页卡片 cardAmount 完全一致（净赚 = sellPrice − price − extraFees）。
 * 未填出售价返回 0；可能为负（亏损转卖）——是否入生活流由调用方判断
 * （useDataStore.syncSaleIncome：仅正净赚记收入）。
 */
export function sellProfit(g: Goods): number {
  const sold = Number.isFinite(g?.sellPrice) ? (g.sellPrice as number) : 0;
  if (sold <= 0) return 0;
  return round(sold - totalInvest(g));
}

/** 持有天数（至少 1 天）。
 * ★v1.3.0：已退役物品的摊销**定格在退役日**（updatedAt 的日期部分）——
 * 用户反馈「卖掉/退役时自动扣减对应金额」：退役后成本不应再按天累计，
 * 否则「卖了 3 个月」还能看到日均成本在涨，与「已经回血/离手」的直觉冲突。
 * 没有 updatedAt（旧数据）时退回 refDate，行为与旧版一致。 */
export function holdDays(g: Goods, refDate: string = today()): number {
  const buy = isValidDate(g?.buyDate) ? g.buyDate : refDate;
  const until = amortRefDate(g, refDate);
  const days = Math.floor((Date.parse(until) - Date.parse(buy)) / 86400000);
  return Math.max(1, days + 1);
}

/** 摊销截止日：在用 → refDate；已退役 → min(退役日, refDate)。 */
export function amortRefDate(g: Goods, refDate: string = today()): string {
  if (g?.status !== 'retired') return refDate;
  const retiredDay = (g.updatedAt ?? '').slice(0, 10);
  if (!isValidDate(retiredDay)) return refDate;
  return retiredDay < refDate ? retiredDay : refDate;
}

/** 日均成本（元/天）。
 * ★v1.3.0：退役物品的持有天数定格在退役日（见 holdDays），净投入仍扣转卖价。 */
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
