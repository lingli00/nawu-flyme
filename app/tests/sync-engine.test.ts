// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * ★v1.7.0 多端增量同步 · 纯函数与 outbox 行为测试。
 *
 * 必须守住的点：
 * 1. **LWW 裁决**：远端严格更新才覆盖；本地有未推送更新（pending）时本地优先；
 *    时间戳相等视为同版本不动本地。
 * 2. **删除墓碑不被复活**：diff 出的 deletes 入队为 op='delete'。
 * 3. **设置敏感键**：aiEndpoint / aiKey 永不上云（推送剥离）、永不被远端覆盖（合并保留本机）。
 * 4. **outbox 去重**：同一记录连改多次只留最后一条（最新数据 + 最新时间戳）。
 * 5. **diff 稳定**：键序不同但内容相同的记录不算变更。
 */

import { enqueueAndNotify, enqueueDeleteAndNotify, findPending, removeEntries, readOutbox, getCursor, setCursor, markNeedSeed, peekNeedSeed, clearNeedSeed } from '../src/sync/outbox';
import {
  diffCollection,
  mergeRoamingSettings,
  recordUpdatedAt,
  remoteShouldWin,
  stableStringify,
  stripSensitiveSettings,
} from '../src/sync/model';
import type { Settings } from '../src/types/entities';

const SID = 'srv_test';

beforeEach(async () => {
  localStorage.clear();
});

describe('diffCollection', () => {
  it('新增 / 更新 / 删除各就各位', () => {
    const before = [
      { id: 'a', amount: 1 },
      { id: 'b', amount: 2 },
    ];
    const after = [
      { id: 'a', amount: 1 },
      { id: 'b', amount: 99 },
      { id: 'c', amount: 3 },
    ];
    const { upserts, deletes } = diffCollection(before, after);
    expect(upserts.map((r) => (r as { id: string }).id).sort()).toEqual(['b', 'c']);
    expect(deletes).toEqual([]);
  });

  it('删除被识别为墓碑', () => {
    const { deletes } = diffCollection([{ id: 'a' }], []);
    expect(deletes).toEqual(['a']);
  });

  it('键序不同但内容相同 → 不算变更', () => {
    const a = [{ id: 'a', note: 'x', amount: 5 }];
    const b = [{ amount: 5, id: 'a', note: 'x' }];
    expect(stableStringify(a[0])).toBe(stableStringify(b[0]));
    const { upserts, deletes } = diffCollection(a, b);
    expect(upserts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe('LWW（remoteShouldWin / recordUpdatedAt）', () => {
  it('远端严格更新才赢', () => {
    expect(remoteShouldWin(1000, 2000, false)).toBe(true);
    expect(remoteShouldWin(2000, 1000, false)).toBe(false);
  });

  it('相等时间戳 = 同版本，不动本地', () => {
    expect(remoteShouldWin(2000, 2000, false)).toBe(false);
  });

  it('本地有未推送的更新 → 远端永远不赢（推完自然覆盖）', () => {
    expect(remoteShouldWin(1000, 9999, true)).toBe(false);
  });

  it('recordUpdatedAt：updatedAt 优先，回落 createdAt，都没有 = 0', () => {
    expect(recordUpdatedAt({ id: 'x', updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-01-02T00:00:00.000Z'),
    );
    expect(recordUpdatedAt({ id: 'x', createdAt: '2026-01-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(recordUpdatedAt({ id: 'x' })).toBe(0);
    expect(recordUpdatedAt(null)).toBe(0);
  });
});

describe('设置漫游（敏感键剥离 / 合并）', () => {
  const base = {
    baseCurrency: 'CNY',
    theme: 'dark' as const,
    aiEndpoint: 'https://my-ai.local',
    aiKey: 'sk-secret',
  };

  it('推送前剥离 aiEndpoint / aiKey', () => {
    const out = stripSensitiveSettings(base as unknown as Settings) as unknown as Record<string, unknown>;
    expect('aiEndpoint' in out).toBe(false);
    expect('aiKey' in out).toBe(false);
    expect(out.theme).toBe('dark');
  });

  it('拉取合并时敏感键以本机为准（双保险）', () => {
    const merged = mergeRoamingSettings(base as unknown as Settings, {
      theme: 'light',
      aiEndpoint: 'https://evil.example',
      aiKey: 'stolen',
    } as Partial<Settings>);
    expect(merged.theme).toBe('light');
    expect(merged.aiEndpoint).toBe('https://my-ai.local');
    expect(merged.aiKey).toBe('sk-secret');
  });
});

describe('outbox', () => {
  it('同一记录连改多次只留最后一条', async () => {
    await enqueueAndNotify(SID, 'valueRecords', 'r1', { id: 'r1', amount: 1 }, 1000);
    await enqueueAndNotify(SID, 'valueRecords', 'r1', { id: 'r1', amount: 2 }, 2000);
    const entries = await readOutbox(SID);
    expect(entries).toHaveLength(1);
    expect(entries[0].updatedAt).toBe(2000);
    expect((entries[0].data as { amount: number }).amount).toBe(2);
  });

  it('upsert 与 delete 互相覆盖（最后写入的形态留下）', async () => {
    await enqueueAndNotify(SID, 'goods', 'g1', { id: 'g1' }, 1000);
    await enqueueDeleteAndNotify(SID, 'goods', 'g1', 2000);
    let entries = await readOutbox(SID);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe('delete');

    await enqueueAndNotify(SID, 'goods', 'g1', { id: 'g1', name: '复活' }, 3000);
    entries = await readOutbox(SID);
    expect(entries[0].op).toBe('upsert');
  });

  it('findPending 只命中不早于 since 的待推送变更', async () => {
    await enqueueAndNotify(SID, 'goods', 'g1', { id: 'g1' }, 5000);
    expect(findPending(await readOutbox(SID), 'goods', 'g1', 4000)).not.toBeNull();
    expect(findPending(await readOutbox(SID), 'goods', 'g1', 6000)).toBeNull();
    expect(findPending(await readOutbox(SID), 'goods', 'g2', 0)).toBeNull();
  });

  it('推送成功后 removeEntries 清掉对应条目', async () => {
    await enqueueAndNotify(SID, 'goods', 'g1', { id: 'g1' }, 1000);
    await enqueueAndNotify(SID, 'goods', 'g2', { id: 'g2' }, 1000);
    await removeEntries(SID, ['goods:g1']);
    const entries = await readOutbox(SID);
    expect(entries).toHaveLength(1);
    expect(entries[0].recordId).toBe('g2');
  });

  it('不同服务器的队列互相隔离', async () => {
    await enqueueAndNotify(SID, 'goods', 'g1', { id: 'g1' }, 1000);
    await enqueueAndNotify('srv_other', 'goods', 'g9', { id: 'g9' }, 1000);
    expect(await readOutbox(SID)).toHaveLength(1);
    expect(await readOutbox('srv_other')).toHaveLength(1);
  });

  it('游标与 needSeed 标记读写', async () => {
    expect(await getCursor(SID)).toBeNull();
    await setCursor(SID, 42);
    expect(await getCursor(SID)).toBe(42);

    expect(await peekNeedSeed(SID)).toBe(false);
    await markNeedSeed(SID);
    expect(await peekNeedSeed(SID)).toBe(true);
    await clearNeedSeed(SID);
    expect(await peekNeedSeed(SID)).toBe(false);
  });
});
