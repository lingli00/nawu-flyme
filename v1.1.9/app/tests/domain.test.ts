import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/date';
import { achieveRate, dailyCost, netInvest, perUseCost, sellProfit, totalInvest } from '../src/domain/goods';
import { monthlyAmount, monthlyAvg, nextRenewCountdown, yearlyAvg } from '../src/domain/subscription';
import { categoryShare, judgementBreakdown, monthlyTrend } from '../src/domain/stats';
import { groupByDay, monthCompare, sumByJudgement } from '../src/domain/ledger';
import { shouldAutoBackup } from '../src/domain/backupPolicy';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { Goods, Subscription, ValueRecord } from '../src/types/entities';

const TODAY = '2026-10-06';

function goods(over: Partial<Goods>): Goods {
  return {
    id: 'g1', name: '测试物', categoryId: 'cg0', tags: [], price: 1000, currency: 'CNY',
    buyDate: addDays(TODAY, -9), status: 'active', extraFees: [], incomes: [], createdAt: '', updatedAt: '',
    ...over,
  } as Goods;
}

function ledger(over: Partial<ValueRecord>): ValueRecord {
  return {
    id: 'v1', type: 'expense', amount: 10, currency: 'CNY', date: TODAY,
    categoryId: 'cl0', judgement: 'xu', createdAt: '', ...over,
  } as ValueRecord;
}

describe('domain/goods · 日均与单次成本', () => {
  it('总投入 = 价格 + 附加费用', () => {
    expect(totalInvest(goods({ price: 1000, extraFees: [{ name: '运费', amount: 50 }] }))).toBe(1050);
  });

  it('日均成本 = (价格+附加费-转卖价) / 持有天数', () => {
    // 买于 9 天前 → 持有 10 天
    const g = goods({ price: 1000, buyDate: addDays(TODAY, -9) });
    expect(dailyCost(g, TODAY)).toBe(100);
    // 退役并卖 400 → 净投入 600 → 60/天
    expect(netInvest(goods({ price: 1000, sellPrice: 400 }))).toBe(600);
    expect(dailyCost(goods({ price: 1000, sellPrice: 400, buyDate: addDays(TODAY, -9) }), TODAY)).toBe(60);
  });

  it('单次成本与达成率', () => {
    const g = goods({ price: 1000, usedCount: 20, countEnabled: true, targetDailyCost: 50 });
    expect(perUseCost(g)).toBe(50);
    // 实际日均 100 > 目标 50 → 50/100 = 0.5
    expect(achieveRate(g, TODAY)).toBe(0.5);
  });

  it('转卖净赚 = 出售价 − 总投入（未填/亏损返回原值，由调用方决定是否入账）', () => {
    // 1000 买入 + 50 运费，卖 1400 → 净赚 350
    expect(sellProfit(goods({ price: 1000, extraFees: [{ name: '运费', amount: 50 }], sellPrice: 1400 }))).toBe(350);
    // 未填出售价 → 0
    expect(sellProfit(goods({ price: 1000 }))).toBe(0);
    // 亏损转卖 → 负值（syncSaleIncome 不记收入）
    expect(sellProfit(goods({ price: 1000, sellPrice: 800 }))).toBe(-200);
  });
});

describe('domain/subscription · 月均口径', () => {
  it('周 × 52/12、月 ×1、年 /12', () => {
    const week = { period: 'week', every: 1, amount: 10 } as Subscription;
    const month = { period: 'month', every: 1, amount: 30 } as Subscription;
    const year = { period: 'year', every: 1, amount: 120 } as Subscription;

    expect(monthlyAmount(week)).toBeCloseTo((10 * 52) / 12, 2);
    expect(monthlyAmount(month)).toBe(30);
    expect(monthlyAmount(year)).toBe(10);

    expect(monthlyAvg([week, month, year])).toBeCloseTo((10 * 52) / 12 + 40, 2);
    expect(yearlyAvg([week, month, year])).toBeCloseTo(((10 * 52) / 12 + 40) * 12, 1);
  });

  it('nextRenewCountdown 计算剩余天数', () => {
    const s = { nextRenewDate: addDays(TODAY, 3), period: 'month', every: 1, amount: 10 } as Subscription;
    expect(nextRenewCountdown(s, TODAY)).toBe(3);
  });
});

describe('domain/ledger + stats · 聚合', () => {
  it('按天分组并按日期倒序', () => {
    const groups = groupByDay([
      ledger({ id: 'a', date: '2026-10-01' }),
      ledger({ id: 'b', date: '2026-10-06' }),
      ledger({ id: 'c', date: '2026-10-06' }),
    ]);
    expect(groups[0]?.date).toBe('2026-10-06');
    expect(groups[0]?.rows).toHaveLength(2);
  });

  it('归/需/否 汇总', () => {
    const sums = sumByJudgement([
      ledger({ judgement: 'gui', amount: 100 }),
      ledger({ judgement: 'fou', amount: 50 }),
      ledger({ judgement: 'xu', amount: 30 }),
    ]);
    expect(sums.gui.amount).toBe(100);
    expect(sums.fou.amount).toBe(50);
    expect(sums.xu.amount).toBe(30);
  });

  it('环比：本月 200、上月 100 → +100%', () => {
    const rows = [
      ledger({ date: '2026-10-06', amount: 200 }),
      ledger({ date: '2026-09-06', amount: 100 }),
    ];
    expect(monthCompare(rows, '2026-10')).toBe(100);
  });

  it('分类占比比例之和为 1，堆叠条同理', () => {
    const rows = [
      ledger({ categoryId: 'cl0', amount: 60, judgement: 'xu' }),
      ledger({ categoryId: 'cl1', amount: 40, judgement: 'fou' }),
    ];
    const shares = categoryShare(rows, SEED_CATEGORIES);
    expect(shares[0]?.name).toBe('餐饮');
    expect(shares.reduce((a, s) => a + s.ratio, 0)).toBeCloseTo(1, 4);

    const stack = judgementBreakdown(rows);
    expect(stack.reduce((a, s) => a + s.ratio, 0)).toBeCloseTo(1, 4);
  });

  it('近 6 月趋势有 6 根柱子', () => {
    const bars = monthlyTrend([ledger({ date: TODAY, amount: 50 })], 6, '2026-10');
    expect(bars).toHaveLength(6);
    expect(bars[5]?.expense).toBe(50);
  });
});

describe('domain/backupPolicy · 24h 节流', () => {
  const base = { loggedIn: true, autoSync: true, lastBackupAt: '', changedSinceBackup: 10 };

  it('从未备份且变更够 → 立即备份', () => {
    expect(shouldAutoBackup(base)).toBe(true);
  });

  it('变更不足 5 条不备份', () => {
    expect(shouldAutoBackup({ ...base, changedSinceBackup: 3 })).toBe(false);
  });

  it('距上次备份不足 24h 不备份', () => {
    expect(shouldAutoBackup({ ...base, lastBackupAt: new Date(Date.now() - 3600_000).toISOString() })).toBe(false);
  });

  it('超过 24h 且变更够 → 备份', () => {
    expect(shouldAutoBackup({ ...base, lastBackupAt: new Date(Date.now() - 25 * 3600_000).toISOString() })).toBe(true);
  });

  it('未登录或关闭自动同步 → 不备份', () => {
    expect(shouldAutoBackup({ ...base, loggedIn: false })).toBe(false);
    expect(shouldAutoBackup({ ...base, autoSync: false })).toBe(false);
  });
});
