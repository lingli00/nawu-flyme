// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { dropOversizeChanges, SYNC_MAX_RECORD_BYTES, type SyncChange } from '../src/sync/model';

/** 服务端单条 >2MB 直接 ignored（不报错）—— 旧版客户端「同步悄悄不生效」的根因之一。 */
describe('dropOversizeChanges（v1.8.0）', () => {
  const big = 'x'.repeat(SYNC_MAX_RECORD_BYTES + 1000);
  const ok = { id: 'g1', name: '耳机' };

  it('超大 upsert 被剔除并给出可读原因，其余照常推送', () => {
    const changes: SyncChange[] = [
      { collection: 'goods', recordId: 'g1', op: 'upsert', data: ok, updatedAt: 1 },
      { collection: 'goods', recordId: 'g2', op: 'upsert', data: { note: big }, updatedAt: 2 },
    ];
    const { keep, dropped } = dropOversizeChanges(changes);
    expect(keep).toHaveLength(1);
    expect(keep[0].recordId).toBe('g1');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('goods:g2');
    expect(dropped[0]).toContain('KB');
  });

  it('删除墓碑 / 小记录一律保留（不误伤）', () => {
    const { keep, dropped } = dropOversizeChanges([
      { collection: 'goods', recordId: 'g3', op: 'delete', data: undefined, updatedAt: 3 },
      { collection: 'goods', recordId: 'g4', op: 'upsert', data: ok, updatedAt: 4 },
    ]);
    expect(dropped).toHaveLength(0);
    expect(keep).toHaveLength(2);
  });

  it('无法序列化的脏数据按超大处理（不让它把整批推送带崩）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { keep, dropped } = dropOversizeChanges([
      { collection: 'goods', recordId: 'g5', op: 'upsert', data: cyclic, updatedAt: 5 },
    ]);
    expect(keep).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
});
