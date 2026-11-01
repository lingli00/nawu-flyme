import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  buildSnapshot,
  snapshotFromJson,
  snapshotItemCount,
  snapshotToJson,
} from '../src/storage/snapshot';
import { createDefaultSettings } from '../src/storage/seed';
import type { SnapshotPayload } from '../src/types/api';

/** 造一份含 12 集合的假数据。 */
function fakeCollections(): Record<string, unknown[]> {
  return {
    goods: [{ id: 'g1' }, { id: 'g2' }],
    subscriptions: [{ id: 's1' }],
    bills: [{ id: 'b1' }],
    valueRecords: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }],
    moods: [],
    times: [],
    wishlist: [],
    cooldowns: [],
    categories: [{ id: 'cl0' }],
    usageRecords: [],
    reminders: [],
    walls: [],
  };
}

describe('storage/snapshot · 快照序列化（验收 6）', () => {
  it('app 固定为 flyme-web，count 只算 3 个集合', () => {
    const snap = buildSnapshot({ collections: fakeCollections(), settings: createDefaultSettings() });
    expect(snap.app).toBe('flyme-web');
    expect(snap.version).toBe(1);
    // goods(2) + subscriptions(1) + valueRecords(3) = 6
    expect(snap.count).toBe(6);
    expect(Object.keys(snap.collections)).toHaveLength(12);
    expect(snap.collections.moods).toEqual([]);
  });

  it('payload 为对象时可反序列化还原', () => {
    const snap = buildSnapshot({ collections: fakeCollections(), settings: createDefaultSettings() });
    const applied = applySnapshot(snap);
    expect(applied.collections.goods).toHaveLength(2);
    expect(applied.collections.valueRecords).toHaveLength(3);
    expect(applied.collections.categories).toHaveLength(1);
    expect(applied.settings.currency).toBe('CNY');
    expect(applied.count).toBe(6);
  });

  it('payload 为 JSON 字符串时同样能还原（F4 双兼容）', () => {
    const snap = buildSnapshot({ collections: fakeCollections(), settings: createDefaultSettings() });
    const text = snapshotToJson(snap);
    const applied = applySnapshot(text);
    expect(applied.collections.goods).toHaveLength(2);
    expect(applied.count).toBe(6);
    expect(snapshotFromJson(text).app).toBe('flyme-web');
  });

  it('缺失集合补空数组，绝不中断', () => {
    const partial = { collections: { goods: [{ id: 'g1' }] }, settings: null, count: 1, app: 'flyme-web', version: 1, exportedAt: '' } as SnapshotPayload;
    const applied = applySnapshot(partial);
    expect(applied.collections.goods).toHaveLength(1);
    expect(applied.collections.walls).toEqual([]);
    expect(applied.settings.currency).toBe('CNY');
  });

  it('完全无法识别的内容抛 parse 错误', () => {
    expect(() => applySnapshot('not-json')).toThrow();
    expect(() => applySnapshot(null)).toThrow();
  });

  it('条数统计可用于「已恢复 N 条」提示', () => {
    const applied = applySnapshot(buildSnapshot({ collections: fakeCollections(), settings: null }));
    expect(snapshotItemCount(applied)).toBe(6);
  });
});
