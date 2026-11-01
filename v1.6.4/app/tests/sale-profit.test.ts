// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  filterSaleEntries,
  saleProfitEntries,
  saleProfitSum,
  saleProfitTotal,
} from '../src/domain/goods';
import type { Goods, ValueRecord } from '../src/types/entities';

/**
 * ★v1.4.0 转卖净赚口径：
 * 首页只显示「当月」，报表承载全部历史并按月/按年筛选。
 * 数据源唯一：生活流 `src='goods-sale'` 记录（售价 − 总投入）。
 */

function rec(id: string, date: string, amount: number, refId?: string): ValueRecord {
  return {
    id,
    type: 'income',
    amount,
    currency: 'CNY',
    date,
    categoryId: 'cl7',
    judgement: 'gui',
    note: refId ? '转卖「测试物品」净赚' : '转卖「已删物品」净赚',
    createdAt: `${date}T00:00:00.000Z`,
    src: 'goods-sale',
    refId,
  } as ValueRecord;
}

function goods(id: string, name: string): Goods {
  return {
    id,
    name,
    categoryId: 'cg0',
    tags: [],
    price: 100,
    currency: 'CNY',
    buyDate: '2026-01-01',
    status: 'retired',
    extraFees: [],
    incomes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Goods;
}

const RECORDS: ValueRecord[] = [
  rec('r1', '2026-10-02', 10, 'g1'),
  rec('r2', '2026-10-20', 90, 'g2'),
  rec('r3', '2026-09-30', 50, 'g1'),
  rec('r4', '2025-12-31', 7, 'g2'),
  // 普通收入不能算进转卖净赚
  { ...rec('r5', '2026-10-10', 999), src: undefined } as ValueRecord,
];
const GOODS = [goods('g1', '镁光DDR4 8G'), goods('g2', 'N95 笔记本')];

describe('转卖净赚 · 明细', () => {
  it('只取 src=goods-sale 的记录，普通收入不算', () => {
    const all = saleProfitEntries(RECORDS, GOODS);
    expect(all).toHaveLength(4);
    expect(all.reduce((a, e) => a + e.amount, 0)).toBe(157);
  });

  it('按日期倒序，名称优先取物品库', () => {
    const all = saleProfitEntries(RECORDS, GOODS);
    expect(all[0]?.date).toBe('2026-10-20');
    expect(all[0]?.name).toBe('N95 笔记本');
  });

  it('物品已删除时从备注里抠名称', () => {
    const all = saleProfitEntries([rec('rx', '2026-10-01', 5)], []);
    expect(all[0]?.name).toBe('已删物品');
  });
});

describe('转卖净赚 · 按月/按年筛选', () => {
  it('当月合计 = 本月所有转卖净赚', () => {
    expect(saleProfitSum(RECORDS, { kind: 'month', key: '2026-10' }, GOODS)).toBe(100);
  });

  it('跨月：9 月只有 1 笔', () => {
    const rows = filterSaleEntries(saleProfitEntries(RECORDS, GOODS), { kind: 'month', key: '2026-09' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(50);
  });

  it('按年合计 = 当年所有月份之和', () => {
    expect(saleProfitSum(RECORDS, { kind: 'year', key: '2026' }, GOODS)).toBe(150);
    expect(saleProfitSum(RECORDS, { kind: 'year', key: '2025' }, GOODS)).toBe(7);
  });

  it('没有记录的周期返回 0', () => {
    expect(saleProfitSum(RECORDS, { kind: 'month', key: '2026-08' }, GOODS)).toBe(0);
  });

  it('全部历史累计不随周期变化', () => {
    expect(saleProfitTotal(saleProfitEntries(RECORDS, GOODS))).toBe(157);
  });
});
