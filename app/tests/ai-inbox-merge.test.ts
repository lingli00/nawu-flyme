import { describe, expect, it } from 'vitest';
import { countInboxRows, mergeInboxEvents, normalizeRow } from '../src/lib/aiInboxMerge';
import { COLLECTIONS } from '../src/types/entities';

const base = () => ({
  valueRecords: [{ id: 'vr1', amount: 10, note: '旧' }],
  goods: [{ id: 'g1', name: '耳机', price: 899 }],
  wishlist: [{ id: 'w1', name: '想买' }],
  walls: [{ id: 'wl1', text: '一句话' }],
  categories: [{ id: 'cl0', name: '餐饮', kind: 'ledger' }],
});

describe('mergeInboxEvents', () => {
  it('只 patch 有改动的集合，不整仓覆盖', () => {
    const out = mergeInboxEvents(base(), [
      { id: 1, records: { goods: [{ id: 'g2', name: '键盘', price: 299 }] } },
    ]);
    expect(Object.keys(out).sort()).toEqual(['goods']);
    expect((out.goods as Array<Record<string, unknown>>).map((r) => r.id)).toEqual(['g2', 'g1']);
  });

  it('新记录放最前，同 id 覆盖且不重复', () => {
    const out = mergeInboxEvents(base(), [
      { id: 1, records: { valueRecords: [{ id: 'vr1', note: '改过' }, { id: 'vr2', amount: 35 }] } },
    ]);
    const rows = out.valueRecords as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('vr2');
    expect(rows[1]).toMatchObject({ id: 'vr1', amount: 10, note: '改过' });
  });

  it('任意额外字段都原样保留（备注/手续费/图片/自定义字段）', () => {
    const out = mergeInboxEvents(base(), [
      {
        id: 1,
        records: {
          goods: [{
            id: 'g2', name: '显示器', price: 1299, note: '下单备注',
            image: { source: 'url', ref: 'x.jpg' },
            extraFees: [{ name: '手续费', amount: 5 }],
            purchaseChannel: '京东',
          }],
        },
      },
    ]);
    const row = (out.goods as Array<Record<string, unknown>>)[0];
    expect(row.purchaseChannel).toBe('京东');
    expect(row.image).toEqual({ source: 'url', ref: 'x.jpg' });
    expect(row.extraFees).toEqual([{ name: '手续费', amount: 5 }]);
  });

  it('patches / deletes / replace 与服务端同口径', () => {
    const out = mergeInboxEvents(base(), [
      {
        id: 1,
        records: {
          patches: { goods: [{ id: 'g1', patch: { note: '加了备注', feeRatePermille: 21 } }] },
          deletes: { wishlist: ['w1'] },
          replace: { walls: [{ id: 'wl2', text: '换掉' }] },
        },
      },
    ]);
    expect((out.goods as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'g1', name: '耳机', note: '加了备注', feeRatePermille: 21,
    });
    expect(out.wishlist).toEqual([]);
    expect(out.walls).toEqual([{ id: 'wl2', text: '换掉' }]);
    expect(out.valueRecords).toBeUndefined();
  });

  it('可写 12 个集合里的任意一个（含自定义分类）', () => {
    const out = mergeInboxEvents(base(), [
      { id: 1, records: { categories: [{ id: 'cu_1', name: '咖啡', kind: 'ledger' }] } },
      { id: 2, records: { subscriptions: [{ id: 's1', name: '网盘', amount: 25, period: 'month' }] } },
      { id: 3, records: { reminders: [{ id: 'r1', kind: 'sub_renew', at: '2026-12-01' }] } },
    ]);
    expect((out.categories as Array<Record<string, unknown>>).some((r) => r.name === '咖啡')).toBe(true);
    expect(Object.keys(out).sort()).toEqual(['categories', 'reminders', 'subscriptions']);
    expect(COLLECTIONS).toHaveLength(12);
  });

  it('多个事件按顺序累计，且不修改原数据', () => {
    const src = base();
    const out = mergeInboxEvents(src, [
      { id: 1, records: { goods: [{ id: 'g2', name: 'A' }] } },
      { id: 2, records: { goods: [{ id: 'g3', name: 'B' }] } },
    ]);
    expect((out.goods as unknown[]).map((r) => (r as { id: string }).id)).toEqual(['g3', 'g2', 'g1']);
    expect(src.goods).toHaveLength(1);
  });

  it('空事件不产生任何改动', () => {
    expect(mergeInboxEvents(base(), [{ id: 1, records: {} }])).toEqual({});
  });

  it('countInboxRows 统计增删改全部行数', () => {
    expect(countInboxRows([
      {
        id: 1,
        records: {
          goods: [{ id: 'g2' }, { id: 'g3' }],
          patches: { goods: [{ id: 'g1', patch: { note: 'x' } }] },
          deletes: { wishlist: ['w1'] },
        },
      },
    ])).toBe(4);
  });
});

/**
 * ★v1.7.7 归一化层（schema 兜底）。
 * 线上事故：AI API 直写的 11 条物品没有 extraFees / tags / incomes，
 * image.ref 还是裸 base64 —— 打开详情整树崩、图片也不显示。
 * 现在合并进来的每一行都先过 normalizeRow，进 store 之前一定是合法形态。
 */
describe('mergeInboxEvents · 归一化层（v1.7.7）', () => {
  const JPEG_B64 = `/9j/4AAQSkZJRgABAQAAAQABAAD${'A'.repeat(140)}`;

  it('物品：缺 tags/extraFees/incomes 补成数组，status/currency 补默认值', () => {
    const row = normalizeRow('goods', { id: 'g9', name: 'AI 导入', price: 99 });
    expect(row.tags).toEqual([]);
    expect(row.extraFees).toEqual([]);
    expect(row.incomes).toEqual([]);
    expect(row.status).toBe('active');
    expect(row.currency).toBe('CNY');
    // 类型非法同样收敛成数组（不是 string / object 就一律清空）
    const row2 = normalizeRow('goods', {
      id: 'g10', tags: '不是数组', extraFees: { name: 'x' }, incomes: null, status: 'retired', currency: 'USD',
    });
    expect(row2.tags).toEqual([]);
    expect(row2.extraFees).toEqual([]);
    expect(row2.incomes).toEqual([]);
    expect(row2.status).toBe('retired'); // 合法值不覆盖
    expect(row2.currency).toBe('USD');
  });

  it('物品 image：裸 base64 自动补 data: 前缀，source 保留，字符串型也收', () => {
    const row = normalizeRow('goods', { id: 'g11', image: { source: 'system', ref: JPEG_B64 } });
    expect(row.image).toEqual({ source: 'system', ref: `data:image/jpeg;base64,${JPEG_B64}` });

    const asString = normalizeRow('goods', { id: 'g12', image: JPEG_B64 });
    expect(asString.image).toEqual({ source: 'local', ref: `data:image/jpeg;base64,${JPEG_B64}` });

    const web = normalizeRow('goods', { id: 'g13', image: 'https://a.com/x.jpg' });
    expect(web.image).toEqual({ source: 'web', ref: 'https://a.com/x.jpg' });

    // 空 / 非法图片 → 直接去掉，不留 undefined ref 的壳
    expect(normalizeRow('goods', { id: 'g14', image: { source: 'local', ref: '' } }).image).toBeUndefined();
  });

  it('生活流：image 同样归一，缺 currency/date/type 兜底', () => {
    const row = normalizeRow('valueRecords', { id: 'vr9', amount: 12, image: JPEG_B64 });
    expect(row.image).toEqual({ source: 'local', ref: `data:image/jpeg;base64,${JPEG_B64}` });
    expect(row.currency).toBe('CNY');
    expect(row.type).toBe('expense');
    expect(typeof row.date).toBe('string');
    expect((row.date as string).length).toBe(10);
  });

  it('订阅 / 账单 / 时光：必填字段补齐', () => {
    const sub = normalizeRow('subscriptions', { id: 's9', name: '网盘' });
    expect(sub.period).toBe('month');
    expect(sub.every).toBe(1);
    expect(sub.remind).toEqual({ renewLead: 3 });
    expect(sub.status).toBe('active');

    const bill = normalizeRow('bills', { id: 'b9', subId: 's9' });
    expect(bill.status).toBe('pending');
    expect(bill.currency).toBe('CNY');
    expect(typeof bill.dueDate).toBe('string');

    const t = normalizeRow('times', { id: 't9' });
    expect(t.tags).toEqual([]);
    expect(t.meaning).toBe('xu');
  });

  it('合并：AI 脏数据进 store 前已是合法形态（detail.extraFees.length 不再炸）', () => {
    const out = mergeInboxEvents(base(), [
      { id: 1, records: { goods: [{ id: 'ai1', name: 'AI 物品', price: 399, image: { source: 'system', ref: JPEG_B64 } }] } },
    ]);
    const row = (out.goods as Array<Record<string, unknown>>).find((r) => r.id === 'ai1') as Record<string, unknown>;
    expect(Array.isArray(row.extraFees)).toBe(true);
    expect((row.extraFees as unknown[]).length).toBe(0);
    expect(Array.isArray(row.tags)).toBe(true);
    expect(row.status).toBe('active');
    expect(row.currency).toBe('CNY');
    // 历史行（base 里已有的脏数据）在本次合并时也顺手修好
    const old = (out.goods as Array<Record<string, unknown>>).find((r) => r.id === 'g1') as Record<string, unknown>;
    expect(Array.isArray(old.extraFees)).toBe(true);
  });

  it('patch 里没带的字段不会被凭空补值冲掉', () => {
    const out = mergeInboxEvents(
      { valueRecords: [{ id: 'vr1', amount: 88, type: 'income', date: '2026-01-02', currency: 'USD' }] },
      [{ id: 1, records: { patches: { valueRecords: [{ id: 'vr1', patch: { note: '只改备注' } }] } } }],
    );
    expect((out.valueRecords as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'vr1', amount: 88, type: 'income', date: '2026-01-02', currency: 'USD', note: '只改备注',
    });
  });
});

/** 假 base64；提到模块顶层避免 TDZ。 */
