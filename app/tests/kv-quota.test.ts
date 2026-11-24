import { afterEach, describe, expect, it } from 'vitest';
import { onKvQuotaFailure, setDriver, setKV } from '../src/storage/kv';

/**
 * ★v1.7.7 · localStorage 配额超限的明确告警（P2）。
 *
 * 旧行为：清掉图标缓存重试一次，重试**再失败**就把 QuotaExceeded 直接抛出去，
 * 上层只显示笼统的「本地保存失败，请重试一次」—— 用户不知道是存储满了、
 * 更不知道「图片可能没存上」。现在重试仍失败时通过 onKvQuotaFailure 明确提示。
 *
 * 同时锁住语义：**不改变 setKV 的 resolve/reject**（仍向上抛），只额外通知一次。
 */
describe('storage/kv · 配额超限告警（v1.7.7）', () => {
  afterEach(() => {
    setDriver(null);
    onKvQuotaFailure(() => undefined);
  });

  /** 造一个只允许 N 字节的假 localStorage（超限抛 QuotaExceededError）。 */
  function fakeStorage(capacity: number): Storage {
    const map = new Map<string, string>();
    const store = {
      get length() {
        return map.size;
      },
      key(i: number): string | null {
        return [...map.keys()][i] ?? null;
      },
      getItem(k: string): string | null {
        return map.has(k) ? (map.get(k) as string) : null;
      },
      setItem(k: string, v: string): void {
        if (v.length > capacity) {
          const err = new Error('QuotaExceededError: exceeded the quota');
          err.name = 'QuotaExceededError';
          throw err;
        }
        map.set(k, v);
      },
      removeItem(k: string): void {
        map.delete(k);
      },
      clear(): void {
        map.clear();
      },
    };
    return store as unknown as Storage;
  }

  it('清缓存重试仍失败 → 通知恰好一次，且仍然 reject（语义不变）', async () => {
    setDriver(null);
    const g = globalThis as { localStorage?: Storage };
    const prev = g.localStorage;
    // 5 字节容量：写什么都超限 → 触发「清缓存重试 → 仍失败」路径
    g.localStorage = fakeStorage(5);
    const hit: string[] = [];
    onKvQuotaFailure((key) => hit.push(key));
    try {
      await expect(setKV('flyme.goods', [{ id: 'g1', name: '很长很长很长很长' }])).rejects.toBeTruthy();
      expect(hit).toEqual(['flyme.goods']);
    } finally {
      g.localStorage = prev;
    }
  });

  it('写入正常时不通知', async () => {
    setDriver(null);
    const g = globalThis as { localStorage?: Storage };
    const prev = g.localStorage;
    g.localStorage = fakeStorage(10_000);
    const hit: string[] = [];
    onKvQuotaFailure((key) => hit.push(key));
    try {
      await setKV('flyme.times', [{ id: 't1' }]);
      expect(hit).toEqual([]);
    } finally {
      g.localStorage = prev;
    }
  });

  it('非配额错误不通知（只在真·存储不足时提示）', async () => {
    setDriver({
      name: 'memory',
      async get() {
        return null;
      },
      async set() {
        throw new Error('原生写入失败');
      },
      async remove() {},
    });
    const hit: string[] = [];
    onKvQuotaFailure((key) => hit.push(key));
    await expect(setKV('flyme.goods', [{ id: 'g1' }])).rejects.toBeTruthy();
    expect(hit).toEqual([]);
  });

  it('hook 自身抛错不影响写入失败的主流程', async () => {
    setDriver(null);
    const g = globalThis as { localStorage?: Storage };
    const prev = g.localStorage;
    g.localStorage = fakeStorage(5);
    onKvQuotaFailure(() => {
      throw new Error('toast 挂了');
    });
    try {
      await expect(setKV('flyme.goods', [{ id: 'g1', name: '很长很长很长很长' }])).rejects.toBeTruthy();
    } finally {
      g.localStorage = prev;
    }
  });
});