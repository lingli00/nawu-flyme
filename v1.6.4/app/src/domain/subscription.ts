import { addDays, addMonths, isValidDate, today } from '../lib/date';
import { round } from '../lib/money';
import { newId } from '../lib/id';
import type { Bill, Subscription } from '../types/entities';

/**
 * 订阅领域计算（纯函数）。
 *
 * 月均口径（架构 §T03 验收②）：
 * - 周：`amount × 52 / 12 / every`
 * - 月：`amount / every`
 * - 年：`amount / 12 / every`
 */

/** 周期 → 每月倍数。 */
export function monthFactorOf(period: Subscription['period']): number {
  if (period === 'week') return 52 / 12;
  if (period === 'year') return 1 / 12;
  return 1;
}

/** 单个订阅的月均成本。 */
export function monthlyAmount(sub: Subscription): number {
  const amount = Number.isFinite(sub?.amount) ? sub.amount : 0;
  const every = Math.max(Number.isFinite(sub?.every) ? sub.every : 1, 1);
  return round((amount * monthFactorOf(sub.period)) / every, 4);
}

/** 单个订阅的年均成本。 */
export function yearlyAmount(sub: Subscription): number {
  return round(monthlyAmount(sub) * 12, 2);
}

/** 一组订阅的月均合计（只算在用：status==='active'）。 */
export function monthlyAvg(subs: Subscription[]): number {
  return round(
    subs.filter((s) => (s?.status ?? 'active') === 'active').reduce((acc, s) => acc + monthlyAmount(s), 0),
    2,
  );
}

/** 一组订阅的年均合计。 */
export function yearlyAvg(subs: Subscription[]): number {
  return round(monthlyAvg(subs) * 12, 2);
}

/** b − a（天）。 */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** 距离下次续费的天数（0=今天到期，负数=已过期未处理）。 */
export function nextRenewCountdown(sub: Subscription, refDate: string = today()): number {
  const date = isValidDate(sub?.nextRenewDate) ? sub.nextRenewDate : refDate;
  return diffDays(refDate, date);
}

/** 续费日期推进一个周期。 */
export function advanceRenewDate(date: string, period: Subscription['period'], every: number): string {
  const step = Math.max(Number.isFinite(every) ? every : 1, 1);
  if (period === 'week') return addDays(date, 7 * step);
  if (period === 'year') return addMonths(date, 12 * step);
  return addMonths(date, step);
}

/** 续费紧急度：过期 / 紧急（≤提醒提前天数）/ 临近（≤7 天）/ 正常。 */
export type RenewLevel = 'overdue' | 'urgent' | 'soon' | 'normal';

export function renewLevel(sub: Subscription, refDate: string = today()): RenewLevel {
  const left = diffDays(refDate, isValidDate(sub?.nextRenewDate) ? sub.nextRenewDate : refDate);
  if (left < 0) return 'overdue';
  if (left <= Math.max(sub?.remind?.renewLead ?? 3, 0)) return 'urgent';
  if (left <= 7) return 'soon';
  return 'normal';
}

/**
 * 补齐待扣款账单。
 *
 * 规则：为每个订阅生成**未来 horizonDays 天内**到期的账单；
 * 已存在（同 subId + 同 dueDate）的不重复生成。返回**新增**的账单。
 */
export function ensurePendingBills(
  subs: Subscription[],
  bills: Bill[],
  horizonDays = 7,
  refDate: string = today(),
): Bill[] {
  const existing = new Set(bills.map((b) => `${b.subId}|${b.dueDate}`));
  const created: Bill[] = [];

  for (const sub of subs) {
    if (!sub || (sub.status ?? 'active') !== 'active') continue;
    if (sub.type === 'lifetime') continue;

    let due = isValidDate(sub.nextRenewDate) ? sub.nextRenewDate : refDate;
    // 已过期的先推进到未来（最多推进 120 次，防止 every=0 造成死循环）
    let guard = 0;
    while (diffDays(refDate, due) < 0 && guard < 120) {
      due = advanceRenewDate(due, sub.period, sub.every ?? 1);
      guard += 1;
    }

    let cursor = due;
    let inner = 0;
    while (diffDays(refDate, cursor) <= horizonDays && inner < 60) {
      const key = `${sub.id}|${cursor}`;
      if (!existing.has(key)) {
        const bill: Bill = {
          id: newId(),
          subId: sub.id,
          dueDate: cursor,
          amount: Number.isFinite(sub.amount) ? sub.amount : 0,
          currency: sub.currency || 'CNY',
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        created.push(bill);
        existing.add(key);
      }
      cursor = advanceRenewDate(cursor, sub.period, sub.every ?? 1);
      inner += 1;
    }
  }
  return created;
}

/** 订阅汇总（概览卡片用）。 */
export interface SubSummary {
  count: number;
  monthly: number;
  yearly: number;
  /** 7 天内要续费的数量（红点用） */
  dueSoon: number;
}

export function summarizeSubs(subs: Subscription[], refDate: string = today()): SubSummary {
  const active = subs.filter((s) => (s?.status ?? 'active') === 'active');
  return {
    count: active.length,
    monthly: monthlyAvg(active),
    yearly: yearlyAvg(active),
    dueSoon: active.filter((s) => {
      const lvl = renewLevel(s, refDate);
      return lvl === 'urgent' || lvl === 'soon' || lvl === 'overdue';
    }).length,
  };
}
