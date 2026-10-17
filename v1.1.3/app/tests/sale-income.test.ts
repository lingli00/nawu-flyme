import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDriver } from '../src/storage/kv';
import { useDataStore } from '../src/store/useDataStore';
import { today } from '../src/lib/date';
import type { Goods, ValueRecord } from '../src/types/entities';

/**
 * ★v1.1.3 「卖出盈利计入生活流」回归。
 *
 * 需求原点：物品转卖有盈利时，净赚应作为一笔额外收入进生活流
 * （用户原话：「他不是应该算我的一部分额外收入吗？」）。
 * 同步入口只有 useDataStore.syncSaleIncome 一个，本测试锁定其建/改/删口径。
 */

function goods(over: Partial<Goods>): Goods {
  return {
    id: 'g1',
    name: '魅族 20',
    categoryId: 'cg0',
    tags: [],
    price: 1000,
    currency: 'CNY',
    buyDate: '2026-01-01',
    status: 'active',
    extraFees: [],
    incomes: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Goods;
}

/** 直接换内存状态（绕过 addGoods 的落盘链路，聚焦同步逻辑）。 */
function seedGoods(list: Goods[]): void {
  useDataStore.setState({ goods: list, valueRecords: [] });
}

const sync = (id: string) => useDataStore.getState().syncSaleIncome(id);
const records = (): ValueRecord[] => useDataStore.getState().valueRecords;
const linked = (id: string): ValueRecord[] =>
  records().filter((r) => r.src === 'goods-sale' && r.refId === id);

describe('syncSaleIncome · 转卖净赚同步生活流', () => {
  beforeEach(() => {
    // 内存驱动：隔离其它测试文件可能留下的持久化状态
    const map = new Map<string, string>();
    setDriver({
      name: 'memory',
      async get(key) {
        return map.has(key) ? (map.get(key) as string) : null;
      },
      async set(key, value) {
        map.set(key, value);
      },
      async remove(key) {
        map.delete(key);
      },
    });
  });

  afterEach(() => {
    setDriver(null);
  });

  it('退役 + 正净赚 → 新建一条 income 记录（归/其他/备注带物品名）', async () => {
    seedGoods([goods({ status: 'retired', sellPrice: 1400, extraFees: [{ name: '运费', amount: 50 }] })]);
    const res = await sync('g1');
    expect(res.action).toBe('created');
    expect(res.amount).toBe(350); // 1400 − (1000+50)
    expect(linked('g1')).toHaveLength(1);
    const row = linked('g1')[0]!;
    expect(row.type).toBe('income');
    expect(row.amount).toBe(350);
    expect(row.judgement).toBe('gui');
    expect(row.categoryId).toBe('cl7');
    expect(row.note).toBe('转卖「魅族 20」净赚');
    expect(row.date).toBe(today());
  });

  it('再同步一次 → 更新原记录（id 与 date 不变，不重复记账）', async () => {
    seedGoods([goods({ status: 'retired', sellPrice: 1400 })]);
    const first = await sync('g1');
    const before = linked('g1')[0]!;
    expect(first.action).toBe('created');

    // 改出售价（模拟编辑表单二次保存）→ 金额跟着变
    useDataStore.setState({ goods: [goods({ status: 'retired', sellPrice: 1600 })] });
    const second = await sync('g1');
    expect(second.action).toBe('updated');
    expect(linked('g1')).toHaveLength(1);
    const after = linked('g1')[0]!;
    expect(after.id).toBe(before.id);
    expect(after.date).toBe(before.date);
    expect(after.amount).toBe(600);
  });

  it('恢复在用 → 移除关联记录（撤回收益）', async () => {
    seedGoods([goods({ status: 'retired', sellPrice: 1400 })]);
    await sync('g1');
    expect(linked('g1')).toHaveLength(1);

    useDataStore.setState({ goods: [goods({ status: 'active' })] });
    const res = await sync('g1');
    expect(res.action).toBe('removed');
    expect(linked('g1')).toHaveLength(0);
    expect(records()).toHaveLength(0);
  });

  it('在役物品（含只填了出售价未退役）→ 不记账', async () => {
    seedGoods([goods({ status: 'active', sellPrice: 1400 })]);
    expect((await sync('g1')).action).toBe('none');
    expect(records()).toHaveLength(0);
  });

  it('亏损转卖（净赚为负）→ 不记账，且清掉历史记录', async () => {
    seedGoods([goods({ status: 'retired', sellPrice: 800 })]);
    expect((await sync('g1')).action).toBe('none');
    expect(records()).toHaveLength(0);

    // 先有收益、后改成亏损价 → 旧记录被移除
    useDataStore.setState({ goods: [goods({ status: 'retired', sellPrice: 1400 })] });
    await sync('g1');
    useDataStore.setState({ goods: [goods({ status: 'retired', sellPrice: 700 })] });
    expect((await sync('g1')).action).toBe('removed');
    expect(records()).toHaveLength(0);
  });

  it('物品已删除 → 清理孤儿收益记录', async () => {
    seedGoods([goods({ status: 'retired', sellPrice: 1400 })]);
    await sync('g1');
    useDataStore.setState({ goods: [] }); // 模拟 removeById('goods', …) 之后
    expect((await sync('g1')).action).toBe('removed');
    expect(records()).toHaveLength(0);
  });

  it('多笔同步互不干扰（各按各的 refId）', async () => {
    seedGoods([
      goods({ id: 'g1', name: 'A', status: 'retired', sellPrice: 1200 }),
      goods({ id: 'g2', name: 'B', status: 'retired', sellPrice: 2400 }),
    ]);
    await sync('g1');
    await sync('g2');
    expect(linked('g1')[0]?.amount).toBe(200);
    expect(linked('g2')[0]?.amount).toBe(1400);
    expect(records()).toHaveLength(2);
  });
});
