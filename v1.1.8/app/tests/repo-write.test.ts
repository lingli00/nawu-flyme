import { afterEach, describe, expect, it } from 'vitest';
import { setDriver } from '../src/storage/kv';
import { loadCollection, onRepoWriteError, saveCollection, saveCollectionNow } from '../src/storage/repo';
import { collectionKey } from '../src/storage/keys';

/**
 * v1.0.29 · 「有概率添加新物品 / 订阅入库失败」回归。
 *
 * 真机根因：Android Preferences 是单 XML 全量重写，写队列被打爆时 setKV 抛错；
 * 旧 repo 里 `void flushOne(name)` 的异常逃逸成 unhandled rejection，
 * 等待它的 resolvers **永远不被调用** → `await addGoods()` 永久挂起：
 * 弹层不关、不提示、数据看着没存上。
 */
describe('storage/repo · 落盘失败不再挂起业务 await', () => {
  afterEach(async () => {
    setDriver(null); // 还原真实驱动解析
  });

  it('setKV 抛错时 saveCollection 仍会 resolve，并触发失败回调', async () => {
    let calls = 0;
    const stored = new Map<string, string>();
    const failed: string[] = [];
    setDriver({
      name: 'memory',
      async get(key) {
        return stored.has(key) ? (stored.get(key) as string) : null;
      },
      async set() {
        calls++;
        throw new Error('模拟原生写入失败');
      },
      async remove() {},
    });
    onRepoWriteError((name) => failed.push(name));

    // 关键断言：await 必须在有限时间内返回（旧实现这里会永久挂起）
    await Promise.race([
      saveCollection('goods', [{ id: 'g1' }]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('saveCollection 挂起了')), 4000)),
    ]);
    expect(calls).toBeGreaterThanOrEqual(3); // 3 次重试
    expect(failed).toContain('goods');
  });

  it('短暂失败后重试能成功写入', async () => {
    let calls = 0;
    const stored = new Map<string, string>();
    setDriver({
      name: 'memory',
      async get(key) {
        return stored.has(key) ? (stored.get(key) as string) : null;
      },
      async set(key, value) {
        calls++;
        if (calls === 1) throw new Error('第一次失败');
        stored.set(key, value);
      },
      async remove() {},
    });
    await saveCollectionNow('times', [{ id: 't1' }]);
    expect(await loadCollection<{ id: string }>('times')).toEqual([{ id: 't1' }]);
    expect(stored.has(collectionKey('times'))).toBe(true);
  });
});
