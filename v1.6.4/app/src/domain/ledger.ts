import { monthKey, monthRange, prevMonth } from '../lib/date';
import { round } from '../lib/money';
import type { Judgement, ValueRecord } from '../types/entities';

/**
 * 生活流派生计算（纯函数）。
 */

/** 按天分组（默认日期倒序，最新在前）。 */
export interface DayGroup {
  date: string;
  rows: ValueRecord[];
  expense: number;
  income: number;
}

export function groupByDay(rows: ValueRecord[], desc = true): DayGroup[] {
  const map = new Map<string, ValueRecord[]>();
  for (const r of rows) {
    const key = r?.date ?? '';
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  const groups: DayGroup[] = [...map.entries()].map(([date, list]) => ({
    date,
    rows: list,
    expense: sumExpense(list),
    income: sumIncome(list),
  }));
  groups.sort((a, b) => (desc ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
  return groups;
}

/** 支出合计。 */
export function sumExpense(rows: ValueRecord[]): number {
  return round(rows.filter((r) => r?.type === 'expense').reduce((acc, r) => acc + (r.amount || 0), 0));
}

/** 收入合计。 */
export function sumIncome(rows: ValueRecord[]): number {
  return round(rows.filter((r) => r?.type === 'income').reduce((acc, r) => acc + (r.amount || 0), 0));
}

/** 净额（收入 − 支出）。 */
export function netAmount(rows: ValueRecord[]): number {
  return round(sumIncome(rows) - sumExpense(rows));
}

/** 按归/需/否汇总（金额 + 笔数）。 */
export interface JudgementSum {
  amount: number;
  count: number;
}

export function sumByJudgement(rows: ValueRecord[]): Record<Judgement, JudgementSum> {
  const out: Record<Judgement, JudgementSum> = {
    gui: { amount: 0, count: 0 },
    xu: { amount: 0, count: 0 },
    fou: { amount: 0, count: 0 },
  };
  for (const r of rows) {
    const j: Judgement = r?.judgement === 'gui' || r?.judgement === 'fou' ? r.judgement : 'xu';
    out[j].amount = round(out[j].amount + (r.amount || 0));
    out[j].count += 1;
  }
  return out;
}

/** 筛选条件。 */
export interface LedgerFilter {
  /** 'YYYY-MM' */
  month?: string;
  /** 'YYYY-MM-DD' 起（含） */
  from?: string;
  /** 'YYYY-MM-DD' 止（含） */
  to?: string;
  judgement?: Judgement;
  categoryId?: string;
  type?: 'expense' | 'income';
  /** 备注关键词 */
  keyword?: string;
}

/** 组合筛选（不修改入参）。 */
export function filterLedger(rows: ValueRecord[], f: LedgerFilter): ValueRecord[] {
  const range = f.month ? monthRange(f.month) : null;
  const kw = (f.keyword ?? '').trim();
  return rows.filter((r) => {
    if (!r) return false;
    if (range && (r.date < range.start || r.date > range.end)) return false;
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (f.judgement && r.judgement !== f.judgement) return false;
    if (f.categoryId && r.categoryId !== f.categoryId) return false;
    if (f.type && r.type !== f.type) return false;
    if (kw && !(r.note ?? '').includes(kw)) return false;
    return true;
  });
}

/** 取某月数据。 */
export function ofMonth(rows: ValueRecord[], ym: string): ValueRecord[] {
  return filterLedger(rows, { month: ym });
}

/** 本月与上月的支出对比（返回百分比变化；上月为 0 时返回 null）。 */
export function monthCompare(rows: ValueRecord[], ym: string = monthKey()): number | null {
  const current = sumExpense(ofMonth(rows, ym));
  const previous = sumExpense(ofMonth(rows, prevMonth(ym)));
  if (previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

/** 某月的收支结构。 */
export interface MonthSummary {
  month: string;
  expense: number;
  income: number;
  net: number;
  byJudgement: Record<Judgement, JudgementSum>;
}

export function monthSummary(rows: ValueRecord[], ym: string = monthKey()): MonthSummary {
  const list = ofMonth(rows, ym);
  const expense = sumExpense(list);
  const income = sumIncome(list);
  return {
    month: ym,
    expense,
    income,
    net: round(income - expense),
    byJudgement: sumByJudgement(list.filter((r) => r.type === 'expense')),
  };
}
