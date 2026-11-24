import { lastNMonths, monthKey, monthRange } from '../lib/date';
import { round } from '../lib/money';
import type { Category, Judgement, ValueRecord } from '../types/entities';
import { sumExpense } from './ledger';

/**
 * 报表聚合（纯函数）。图表全部自绘 SVG，这里只产出数值。
 */

/** 环图/柱图配色（8 色循环，与 PRD 的纸质暖调一致）。 */
export const CHART_PALETTE: string[] = [
  '#3f7d67',
  '#4a7fb5',
  '#b98a1f',
  '#c2603f',
  '#7a6bb5',
  '#3f8f6a',
  '#8a6f5a',
  '#5b8c8a',
];

/** 环图切片。 */
export interface CategorySlice {
  categoryId: string;
  name: string;
  icon: string;
  amount: number;
  /** 0~1 */
  ratio: number;
  color: string;
}

/** 分类占比（环图）。默认只统计支出。 */
export function categoryShare(
  rows: ValueRecord[],
  categories: Category[],
  opts: { type?: 'expense' | 'income'; months?: number } = {},
): CategorySlice[] {
  const type = opts.type ?? 'expense';
  const list = rows.filter((r) => r?.type === type);
  const total = list.reduce((acc, r) => acc + (r.amount || 0), 0);
  if (total <= 0) return [];

  const byId = new Map<string, number>();
  for (const r of list) {
    const id = r.categoryId ?? 'cl7';
    byId.set(id, (byId.get(id) ?? 0) + (r.amount || 0));
  }

  return [...byId.entries()]
    .map(([categoryId, amount]) => {
      const cat = categories.find((c) => c.id === categoryId);
      return {
        categoryId,
        name: cat?.name ?? '其他',
        icon: cat?.icon ?? 'tag',
        amount: round(amount),
        ratio: round(amount / total, 4),
        color: '',
      };
    })
    .sort((a, b) => b.amount - a.amount)
    .map((slice, index) => ({ ...slice, color: CHART_PALETTE[index % CHART_PALETTE.length] as string }));
}

/** 近 N 月柱状趋势。 */
export interface MonthBar {
  month: string;
  label: string;
  expense: number;
  income: number;
}

export function monthlyTrend(rows: ValueRecord[], n = 6, from: string = monthKey()): MonthBar[] {
  const months = lastNMonths(n, `${from}-01`);
  return months.map((ym) => {
    const { start, end } = monthRange(ym);
    const list = rows.filter((r) => r && r.date >= start && r.date <= end);
    return {
      month: ym,
      label: `${Number(ym.slice(5, 7))}月`,
      expense: sumExpense(list),
      income: round(list.filter((r) => r.type === 'income').reduce((acc, r) => acc + (r.amount || 0), 0)),
    };
  });
}

/** 归/需/否 三色堆叠条（总支出 = 100%）。 */
export interface JudgementStack {
  judgement: Judgement;
  label: string;
  amount: number;
  /** 0~1 */
  ratio: number;
  color: string;
}

export function judgementBreakdown(rows: ValueRecord[]): JudgementStack[] {
  const list = rows.filter((r) => r?.type === 'expense');
  const total = list.reduce((acc, r) => acc + (r.amount || 0), 0);
  const buckets: Array<{ judgement: Judgement; label: string; color: string; amount: number }> = [
    { judgement: 'gui', label: '归', color: '#3f8f6a', amount: 0 },
    { judgement: 'xu', label: '需', color: '#4a7fb5', amount: 0 },
    { judgement: 'fou', label: '否', color: '#c2603f', amount: 0 },
  ];
  for (const r of list) {
    const bucket = buckets.find((b) => b.judgement === r.judgement) ?? buckets[1]!;
    bucket.amount = round(bucket.amount + (r.amount || 0));
  }
  return buckets.map((b) => ({
    judgement: b.judgement,
    label: b.label,
    amount: b.amount,
    ratio: total > 0 ? round(b.amount / total, 4) : 0,
    color: b.color,
  }));
}

/** TOP N 分类（概览「本月 TOP3」用）。 */
export interface TopCategoryRow extends CategorySlice {
  count: number;
}

export function topCategories(
  rows: ValueRecord[],
  categories: Category[],
  n = 3,
  ym: string = monthKey(),
): TopCategoryRow[] {
  const { start, end } = monthRange(ym);
  const list = rows.filter((r) => r?.type === 'expense' && r.date >= start && r.date <= end);
  const shares = categoryShare(list, categories, { type: 'expense' });
  const countById = new Map<string, number>();
  for (const r of list) countById.set(r.categoryId, (countById.get(r.categoryId) ?? 0) + 1);

  return shares.slice(0, n).map((s) => ({ ...s, count: countById.get(s.categoryId) ?? 0 }));
}

/** 概览头部数字。 */
export interface OverviewStats {
  month: string;
  expense: number;
  income: number;
  net: number;
  stack: JudgementStack[];
  top: TopCategoryRow[];
}

export function overviewStats(
  rows: ValueRecord[],
  categories: Category[],
  ym: string = monthKey(),
): OverviewStats {
  const { start, end } = monthRange(ym);
  const list = rows.filter((r) => r && r.date >= start && r.date <= end);
  const expense = sumExpense(list);
  const income = round(list.filter((r) => r.type === 'income').reduce((acc, r) => acc + (r.amount || 0), 0));
  return {
    month: ym,
    expense,
    income,
    net: round(income - expense),
    stack: judgementBreakdown(list),
    top: topCategories(rows, categories, 3, ym),
  };
}
